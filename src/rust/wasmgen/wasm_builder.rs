use std::collections::HashMap;
use std::mem::transmute;

use crate::leb::{
    write_fixed_leb16_at_idx, write_fixed_leb32_at_idx, write_leb_i32, write_leb_i64, write_leb_u32,
};
use crate::wasmgen::wasm_opcodes as op;

pub trait SafeToU8 {
    fn safe_to_u8(self) -> u8;
}
impl SafeToU8 for usize {
    fn safe_to_u8(self) -> u8 {
        dbg_assert!(self <= ::std::u8::MAX as usize);
        self as u8
    }
}

pub trait SafeToU16 {
    fn safe_to_u16(self) -> u16;
}
impl SafeToU16 for usize {
    fn safe_to_u16(self) -> u16 {
        dbg_assert!(self <= ::std::u16::MAX as usize);
        self as u16
    }
}

#[derive(PartialEq)]
#[allow(non_camel_case_types)]
enum FunctionType {
    FN0,
    FN1,
    FN2,
    FN3,

    FN0_RET,
    FN0_RET_I64,
    FN1_RET,
    FN2_RET,

    FN1_RET_I64,
    FN1_F32_RET,
    FN1_F64_RET,

    FN2_I32_I64,
    FN2_I64_I32,
    FN2_I64_I32_RET,
    FN2_I64_I32_RET_I64,
    FN2_F32_I32,

    FN3_RET,

    FN3_I64_I32_I32,
    FN3_I32_I64_I32,
    FN3_I32_I64_I32_RET,
    FN4_I32_I64_I64_I32_RET,
    // When adding at the end, update LAST below
}

impl FunctionType {
    pub fn of_u8(x: u8) -> FunctionType {
        dbg_assert!(x <= FunctionType::LAST as u8);
        unsafe { transmute(x) }
    }
    pub fn to_u8(self: FunctionType) -> u8 { self as u8 }
    pub const LAST: FunctionType = FunctionType::FN4_I32_I64_I64_I32_RET;
}

pub const WASM_MODULE_ARGUMENT_COUNT: u8 = 1;

pub struct WasmBuilder {
    output: Vec<u8>,
    instruction_body: Vec<u8>,

    idx_import_table_size: usize, // for rewriting once finished
    idx_import_count: usize,      // for rewriting once finished
    idx_import_entries: usize,    // for searching the imports

    import_table_size: usize, // the current import table size (to avoid reading 2 byte leb)
    import_count: u16,        // same as above
    initial_static_size: usize, // size of module after initialization, rest is drained on reset
    // if set, finish() imports guest RAM as a second memory: (min_pages, max_pages, shared)
    #[cfg(any(test, feature = "guest-ram-import"))]
    guest_memory_import: Option<(u32, u32, bool)>,
    // label for referencing block/if/loop constructs directly via branch instructions
    next_label: Label,
    label_stack: Vec<Label>,
    label_to_depth: HashMap<Label, usize>,
    free_locals_i32: Vec<WasmLocal>,
    free_locals_i64: Vec<WasmLocalI64>,
    local_count: u8,
    pub arg_local_initial_state: WasmLocal,
}

#[derive(Eq, PartialEq)]
pub struct WasmLocal(u8);
impl WasmLocal {
    pub fn idx(&self) -> u8 { self.0 }
    /// Unsafe: Can result in multiple free's. Should only be used for locals that are used during
    /// the whole module (for example, registers)
    pub fn unsafe_clone(&self) -> WasmLocal { WasmLocal(self.0) }
}

pub struct WasmLocalI64(u8);
impl WasmLocalI64 {
    pub fn idx(&self) -> u8 { self.0 }
}

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
pub struct Label(u32);
impl Label {
    const ZERO: Label = Label(0);
    fn next(&self) -> Label { Label(self.0.wrapping_add(1)) }
}
#[cfg_attr(feature = "guest-ram-import", allow(dead_code))]
impl WasmBuilder {
    pub fn new() -> Self {
        let mut b = WasmBuilder {
            output: Vec::with_capacity(256),
            instruction_body: Vec::with_capacity(256),

            idx_import_table_size: 0,
            idx_import_count: 0,
            idx_import_entries: 0,

            import_table_size: 2,
            import_count: 0,
            initial_static_size: 0,
            #[cfg(any(test, feature = "guest-ram-import"))]
            guest_memory_import: None,
            label_to_depth: HashMap::new(),
            label_stack: Vec::new(),
            next_label: Label::ZERO,

            free_locals_i32: Vec::with_capacity(8),
            free_locals_i64: Vec::with_capacity(8),
            local_count: 0,
            arg_local_initial_state: WasmLocal(0),
        };
        b.init();
        b
    }

    fn init(&mut self) {
        self.output.extend("\0asm".as_bytes());

        // wasm version in leb128, 4 bytes
        self.output.push(op::WASM_VERSION);
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);

        self.write_type_section();
        self.write_import_section_preamble();

        // store state of current pointers etc. so we can reset them later
        self.initial_static_size = self.output.len();
    }

    pub fn reset(&mut self) {
        self.output.drain(self.initial_static_size..);
        self.set_import_table_size(2);
        self.set_import_count(0);
        self.instruction_body.clear();
        self.free_locals_i32.clear();
        self.free_locals_i64.clear();
        self.local_count = 0;

        dbg_assert!(self.label_to_depth.is_empty());
        dbg_assert!(self.label_stack.is_empty());
        self.next_label = Label::ZERO;
    }

    pub fn finish(&mut self) -> usize {
        dbg_assert!(self.label_to_depth.is_empty());
        dbg_assert!(self.label_stack.is_empty());

        self.write_memory_import();
        #[cfg(any(test, feature = "guest-ram-import"))]
        if let Some((min_pages, max_pages, shared)) = self.effective_guest_memory_import() {
            self.write_guest_memory_import(min_pages, max_pages, shared);
        }
        self.write_function_section();
        self.write_export_section();
        // write code section preamble
        self.output.push(op::SC_CODE);
        let idx_code_section_size = self.output.len(); // we will write to this location later
        self.output.push(0);
        self.output.push(0); // write temp val for now using 4 bytes
        self.output.push(0);
        self.output.push(0);
        self.output.push(1); // number of function bodies: just 1
                             // same as above but for body size of the function
        let idx_fn_body_size = self.output.len();
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);
        self.output.push(0);

        dbg_assert!(
            self.local_count as usize == self.free_locals_i32.len() + self.free_locals_i64.len(),
            "All locals should have been freed"
        );

        let free_locals_i32 = &self.free_locals_i32;
        let free_locals_i64 = &self.free_locals_i64;

        let locals = (0..self.local_count).map(|i| {
            let local_index = WASM_MODULE_ARGUMENT_COUNT + i;
            if free_locals_i64.iter().any(|v| v.idx() == local_index) {
                op::TYPE_I64
            }
            else {
                dbg_assert!(free_locals_i32.iter().any(|v| v.idx() == local_index));
                op::TYPE_I32
            }
        });
        let mut groups = vec![];
        for local_type in locals {
            if let Some(last) = groups.last_mut() {
                let (last_type, last_count) = *last;
                if last_type == local_type {
                    *last = (local_type, last_count + 1);
                    continue;
                }
            }
            groups.push((local_type, 1));
        }
        dbg_assert!(groups.len() < 128);
        self.output.push(groups.len().safe_to_u8());
        for (local_type, count) in groups {
            dbg_assert!(count < 128);
            self.output.push(count);
            self.output.push(local_type);
        }

        self.output.append(&mut self.instruction_body);

        self.output.push(op::OP_END);

        // write the actual sizes to the pointer locations stored above. We subtract 4 from the actual
        // value because the ptr itself points to four bytes
        let fn_body_size = (self.output.len() - idx_fn_body_size - 4) as u32;
        write_fixed_leb32_at_idx(&mut self.output, idx_fn_body_size, fn_body_size);

        let code_section_size = (self.output.len() - idx_code_section_size - 4) as u32;
        write_fixed_leb32_at_idx(&mut self.output, idx_code_section_size, code_section_size);

        self.output.len()
    }

    pub fn write_type_section(&mut self) {
        self.output.push(op::SC_TYPE);

        let idx_section_size = self.output.len();
        self.output.push(0);
        self.output.push(0);

        let nr_of_function_types = FunctionType::to_u8(FunctionType::LAST) + 1;
        dbg_assert!(nr_of_function_types < 128);
        self.output.push(nr_of_function_types);

        for i in 0..(nr_of_function_types) {
            match FunctionType::of_u8(i) {
                FunctionType::FN0 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0); // no args
                    self.output.push(0); // no return val
                },
                FunctionType::FN1 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN2 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN0_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN0_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(0);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN1_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN1_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN1_F32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_F32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN1_F64_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(1);
                    self.output.push(op::TYPE_F64);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_I32_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(0);
                },
                FunctionType::FN2_I64_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN2_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN2_I64_I32_RET_I64 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I64);
                },
                FunctionType::FN2_F32_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(2);
                    self.output.push(op::TYPE_F32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN3_I64_I32_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_I32_I64_I32 => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(0);
                },
                FunctionType::FN3_I32_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(3);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
                FunctionType::FN4_I32_I64_I64_I32_RET => {
                    self.output.push(op::TYPE_FUNC);
                    self.output.push(4);
                    self.output.push(op::TYPE_I32);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I64);
                    self.output.push(op::TYPE_I32);
                    self.output.push(1);
                    self.output.push(op::TYPE_I32);
                },
            }
        }

        let new_len = self.output.len();
        let size = (new_len - 2) - idx_section_size;
        write_fixed_leb16_at_idx(&mut self.output, idx_section_size, size.safe_to_u16());
    }

    /// Goes over the import block to find index of an import entry by function name
    pub fn get_import_index(&self, fn_name: &str) -> Option<u16> {
        let mut offset = self.idx_import_entries;
        for i in 0..self.import_count {
            offset += 1; // skip length of module name
            offset += 1; // skip module name itself
            let len = self.output[offset] as usize;
            offset += 1;
            let name = self
                .output
                .get(offset..(offset + len))
                .expect("get function name");
            if name == fn_name.as_bytes() {
                return Some(i);
            }
            offset += len; // skip the string
            offset += 1; // skip import kind
            offset += 1; // skip type index
        }
        None
    }

    pub fn set_import_count(&mut self, count: u16) {
        dbg_assert!(count < 0x4000);
        self.import_count = count;
        let idx_import_count = self.idx_import_count;
        write_fixed_leb16_at_idx(&mut self.output, idx_import_count, count);
    }

    pub fn set_import_table_size(&mut self, size: usize) {
        dbg_assert!(size < 0x4000);
        self.import_table_size = size;
        let idx_import_table_size = self.idx_import_table_size;
        write_fixed_leb16_at_idx(&mut self.output, idx_import_table_size, size.safe_to_u16());
    }

    pub fn write_import_section_preamble(&mut self) {
        self.output.push(op::SC_IMPORT);

        self.idx_import_table_size = self.output.len();
        self.output.push(1 | 0b10000000);
        self.output.push(2); // 2 in 2 byte leb

        self.idx_import_count = self.output.len();
        self.output.push(1 | 0b10000000);
        self.output.push(0); // 0 in 2 byte leb

        // here after starts the actual list of imports
        self.idx_import_entries = self.output.len();
    }

    pub fn write_memory_import(&mut self) {
        self.output.push(1);
        self.output.push('e' as u8);
        self.output.push(1);
        self.output.push('m' as u8);

        self.output.push(op::EXT_MEMORY);

        self.output.push(0); // memory flag, 0 for no maximum memory limit present
        write_leb_u32(&mut self.output, 64); // initial memory length of 64 pages, takes 1 bytes in leb128

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 7;
        self.set_import_table_size(new_table_size);
    }

    fn write_import_entry(&mut self, fn_name: &str, type_index: FunctionType) -> u16 {
        self.output.push(1); // length of module name
        self.output.push('e' as u8); // module name
        self.output.push(fn_name.len().safe_to_u8());
        self.output.extend(fn_name.as_bytes());
        self.output.push(op::EXT_FUNCTION);
        self.output.push(type_index.to_u8());

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + 1 + 1 + 1 + fn_name.len() + 1 + 1;
        self.set_import_table_size(new_table_size);

        self.import_count - 1
    }

    pub fn write_function_section(&mut self) {
        self.output.push(op::SC_FUNCTION);
        self.output.push(2); // length of this section
        self.output.push(1); // count of signature indices
        self.output.push(FunctionType::FN1.to_u8());
    }

    #[cfg(not(any(test, feature = "guest-ram-import")))]
    pub fn write_export_section(&mut self) {
        self.output.push(op::SC_EXPORT);
        self.output.push(1 + 1 + 1 + 1 + 2); // size of this section
        self.output.push(1); // count of table: just one function exported

        self.output.push(1); // length of exported function name
        self.output.push('f' as u8); // function name
        self.output.push(op::EXT_FUNCTION);

        // index of the exported function
        // function space starts with imports. index of last import is import count - 1
        // the last import however is a memory, so we subtract one from that
        let next_op_idx = self.output.len();
        self.output.push(0);
        self.output.push(0); // add 2 bytes for writing 16 byte val
        write_fixed_leb16_at_idx(&mut self.output, next_op_idx, self.import_count - 1);
    }
    fn get_fn_idx(&mut self, fn_name: &str, type_index: FunctionType) -> u16 {
        match self.get_import_index(fn_name) {
            Some(idx) => idx,
            None => {
                let idx = self.write_import_entry(fn_name, type_index);
                idx
            },
        }
    }

    pub fn get_output_ptr(&self) -> *const u8 { self.output.as_ptr() }
    pub fn get_output_len(&self) -> u32 { self.output.len() as u32 }

    fn open_block(&mut self) -> Label {
        let label = self.next_label;
        self.next_label = self.next_label.next();
        self.label_to_depth
            .insert(label, self.label_stack.len() + 1);
        self.label_stack.push(label);
        label
    }
    fn close_block(&mut self) {
        let label = self.label_stack.pop().unwrap();
        let old_depth = self.label_to_depth.remove(&label).unwrap();
        dbg_assert!(self.label_to_depth.len() + 1 == old_depth);
    }

    #[must_use = "local allocated but not used"]
    fn alloc_local(&mut self) -> WasmLocal {
        match self.free_locals_i32.pop() {
            Some(local) => local,
            None => {
                let new_idx = self.local_count + WASM_MODULE_ARGUMENT_COUNT;
                self.local_count = self.local_count.checked_add(1).unwrap();
                WasmLocal(new_idx)
            },
        }
    }
    pub fn free_local(&mut self, local: WasmLocal) {
        dbg_assert!(
            (WASM_MODULE_ARGUMENT_COUNT..self.local_count + WASM_MODULE_ARGUMENT_COUNT)
                .contains(&local.0)
        );
        self.free_locals_i32.push(local)
    }

    #[must_use = "local allocated but not used"]
    pub fn set_new_local(&mut self) -> WasmLocal {
        let local = self.alloc_local();
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    #[must_use = "local allocated but not used"]
    pub fn tee_new_local(&mut self) -> WasmLocal {
        let local = self.alloc_local();
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    pub fn set_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
    }
    pub fn tee_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
    }
    pub fn get_local(&mut self, local: &WasmLocal) {
        self.instruction_body.push(op::OP_GETLOCAL);
        self.instruction_body.push(local.idx());
    }

    #[must_use = "local allocated but not used"]
    fn alloc_local_i64(&mut self) -> WasmLocalI64 {
        match self.free_locals_i64.pop() {
            Some(local) => local,
            None => {
                let new_idx = self.local_count + WASM_MODULE_ARGUMENT_COUNT;
                self.local_count += 1;
                WasmLocalI64(new_idx)
            },
        }
    }
    pub fn free_local_i64(&mut self, local: WasmLocalI64) {
        dbg_assert!(
            (WASM_MODULE_ARGUMENT_COUNT..self.local_count + WASM_MODULE_ARGUMENT_COUNT)
                .contains(&local.0)
        );
        self.free_locals_i64.push(local)
    }
    #[must_use = "local allocated but not used"]
    pub fn set_new_local_i64(&mut self) -> WasmLocalI64 {
        let local = self.alloc_local_i64();
        self.instruction_body.push(op::OP_SETLOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    #[must_use = "local allocated but not used"]
    pub fn tee_new_local_i64(&mut self) -> WasmLocalI64 {
        let local = self.alloc_local_i64();
        self.instruction_body.push(op::OP_TEELOCAL);
        self.instruction_body.push(local.idx());
        local
    }
    pub fn get_local_i64(&mut self, local: &WasmLocalI64) {
        self.instruction_body.push(op::OP_GETLOCAL);
        self.instruction_body.push(local.idx());
    }

    pub fn const_i32(&mut self, v: i32) {
        self.instruction_body.push(op::OP_I32CONST);
        write_leb_i32(&mut self.instruction_body, v);
    }
    pub fn const_i64(&mut self, v: i64) {
        self.instruction_body.push(op::OP_I64CONST);
        write_leb_i64(&mut self.instruction_body, v);
    }

    pub fn load_fixed_u8(&mut self, addr: u32) {
        self.const_i32(addr as i32);
        self.load_u8(0);
    }
    pub fn load_fixed_u16(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 1) == 0);

        self.const_i32(addr as i32);
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_ALIGN16);
        self.instruction_body.push(0); // immediate offset
    }
    pub fn load_fixed_i32(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 3) == 0);

        self.const_i32(addr as i32);
        self.load_aligned_i32(0);
    }
    pub fn load_fixed_i64(&mut self, addr: u32) {
        // doesn't cause a failure in the generated code, but it will be much slower
        dbg_assert!((addr & 7) == 0);

        self.const_i32(addr as i32);
        self.load_aligned_i64(0);
    }

    pub fn load_u8(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD8U);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64LOAD);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_unaligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_f64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F64LOAD);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64LOAD);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_f32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_F32LOAD);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn load_aligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.instruction_body.push(op::MEM_ALIGN16);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_u8(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE8);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE16);
        self.instruction_body.push(op::MEM_ALIGN16);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE);
        self.instruction_body.push(op::MEM_ALIGN32);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_aligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.instruction_body.push(op::MEM_ALIGN64);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_u16(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE16);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_i32(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn store_unaligned_i64(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.instruction_body.push(op::MEM_NO_ALIGN);
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    pub fn increment_fixed_i64(&mut self, byte_offset: u32, n: i64) {
        self.const_i32(byte_offset as i32);
        self.load_fixed_i64(byte_offset);
        self.const_i64(n);
        self.add_i64();
        self.store_aligned_i64(0);
    }

    pub fn add_i32(&mut self) { self.instruction_body.push(op::OP_I32ADD); }
    pub fn add_i64(&mut self) { self.instruction_body.push(op::OP_I64ADD); }
    pub fn sub_i32(&mut self) { self.instruction_body.push(op::OP_I32SUB); }
    pub fn and_i32(&mut self) { self.instruction_body.push(op::OP_I32AND); }
    pub fn or_i32(&mut self) { self.instruction_body.push(op::OP_I32OR); }
    pub fn or_i64(&mut self) { self.instruction_body.push(op::OP_I64OR); }
    pub fn xor_i32(&mut self) { self.instruction_body.push(op::OP_I32XOR); }
    pub fn mul_i32(&mut self) { self.instruction_body.push(op::OP_I32MUL); }
    pub fn mul_i64(&mut self) { self.instruction_body.push(op::OP_I64MUL); }
    pub fn div_i64(&mut self) { self.instruction_body.push(op::OP_I64DIVU); }
    pub fn rem_i64(&mut self) { self.instruction_body.push(op::OP_I64REMU); }

    pub fn rotl_i32(&mut self) { self.instruction_body.push(op::OP_I32ROTL); }

    pub fn shl_i32(&mut self) { self.instruction_body.push(op::OP_I32SHL); }
    pub fn shl_i64(&mut self) { self.instruction_body.push(op::OP_I64SHL); }
    pub fn shr_u_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRU); }
    pub fn shr_u_i64(&mut self) { self.instruction_body.push(op::OP_I64SHRU); }
    pub fn shr_s_i32(&mut self) { self.instruction_body.push(op::OP_I32SHRS); }

    pub fn eq_i32(&mut self) { self.instruction_body.push(op::OP_I32EQ); }
    pub fn eq_i64(&mut self) { self.instruction_body.push(op::OP_I64EQ); }
    pub fn ne_i32(&mut self) { self.instruction_body.push(op::OP_I32NE); }
    pub fn ne_i64(&mut self) { self.instruction_body.push(op::OP_I64NE); }

    pub fn le_i32(&mut self) { self.instruction_body.push(op::OP_I32LES); }
    pub fn lt_i32(&mut self) { self.instruction_body.push(op::OP_I32LTS); }
    pub fn ge_i32(&mut self) { self.instruction_body.push(op::OP_I32GES); }
    pub fn gt_i32(&mut self) { self.instruction_body.push(op::OP_I32GTS); }

    pub fn gtu_i32(&mut self) { self.instruction_body.push(op::OP_I32GTU); }
    pub fn geu_i32(&mut self) { self.instruction_body.push(op::OP_I32GEU); }
    pub fn ltu_i32(&mut self) { self.instruction_body.push(op::OP_I32LTU); }
    pub fn leu_i32(&mut self) { self.instruction_body.push(op::OP_I32LEU); }

    pub fn gtu_i64(&mut self) { self.instruction_body.push(op::OP_I64GTU); }

    pub fn reinterpret_i32_as_f32(&mut self) {
        self.instruction_body.push(op::OP_F32REINTERPRETI32);
    }
    //pub fn reinterpret_f32_as_i32(&mut self) {
    //    self.instruction_body.push(op::OP_I32REINTERPRETF32);
    //}
    pub fn reinterpret_i64_as_f64(&mut self) {
        self.instruction_body.push(op::OP_F64REINTERPRETI64);
    }
    //pub fn reinterpret_f64_as_i64(&mut self) {
    //    self.instruction_body.push(op::OP_I64REINTERPRETF64);
    //}
    //pub fn promote_f32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64PROMOTEF32); }
    //pub fn demote_f64_to_f32(&mut self) { self.instruction_body.push(op::OP_F32DEMOTEF64); }
    //pub fn convert_i32_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI32); }
    //pub fn convert_i64_to_f64(&mut self) { self.instruction_body.push(op::OP_F64CONVERTSI64); }
    pub fn extend_unsigned_i32_to_i64(&mut self) {
        self.instruction_body.push(op::OP_I64EXTENDUI32);
    }
    pub fn extend_signed_i32_to_i64(&mut self) { self.instruction_body.push(op::OP_I64EXTENDSI32); }
    pub fn wrap_i64_to_i32(&mut self) { self.instruction_body.push(op::OP_I32WRAPI64); }

    pub fn eqz_i32(&mut self) { self.instruction_body.push(op::OP_I32EQZ); }

    pub fn select(&mut self) { self.instruction_body.push(op::OP_SELECT); }

    pub fn if_i32(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_I32);
    }
    #[allow(dead_code)]
    pub fn if_i64(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_I64);
    }
    #[allow(dead_code)]
    pub fn block_i32(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_BLOCK);
        self.instruction_body.push(op::TYPE_I32);
    }

    pub fn if_void(&mut self) {
        self.open_block();
        self.instruction_body.push(op::OP_IF);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
    }

    pub fn else_(&mut self) {
        dbg_assert!(!self.label_stack.is_empty());
        self.instruction_body.push(op::OP_ELSE);
    }

    pub fn loop_void(&mut self) -> Label {
        self.instruction_body.push(op::OP_LOOP);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
        self.open_block()
    }

    pub fn block_void(&mut self) -> Label {
        self.instruction_body.push(op::OP_BLOCK);
        self.instruction_body.push(op::TYPE_VOID_BLOCK);
        self.open_block()
    }

    pub fn block_end(&mut self) {
        self.close_block();
        self.instruction_body.push(op::OP_END);
    }

    pub fn return_(&mut self) { self.instruction_body.push(op::OP_RETURN); }

    #[allow(dead_code)]
    pub fn drop_(&mut self) { self.instruction_body.push(op::OP_DROP); }

    pub fn brtable(
        &mut self,
        default_case: Label,
        cases: &mut dyn std::iter::ExactSizeIterator<Item = &Label>,
    ) {
        self.instruction_body.push(op::OP_BRTABLE);
        write_leb_u32(&mut self.instruction_body, cases.len() as u32);
        for case in cases {
            self.write_label(*case);
        }
        self.write_label(default_case);
    }

    pub fn br(&mut self, label: Label) {
        self.instruction_body.push(op::OP_BR);
        self.write_label(label);
    }
    pub fn br_if(&mut self, label: Label) {
        self.instruction_body.push(op::OP_BRIF);
        self.write_label(label);
    }

    fn write_label(&mut self, label: Label) {
        let depth = *self.label_to_depth.get(&label).unwrap();
        dbg_assert!(depth <= self.label_stack.len());
        write_leb_u32(
            &mut self.instruction_body,
            (self.label_stack.len() - depth) as u32,
        );
    }

    fn call_fn(&mut self, name: &str, function: FunctionType) {
        let i = self.get_fn_idx(name, function);
        self.instruction_body.push(op::OP_CALL);
        write_leb_u32(&mut self.instruction_body, i as u32);
    }

    pub fn call_fn0(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0) }
    pub fn call_fn0_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0_RET) }
    pub fn call_fn0_ret_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN0_RET_I64) }
    pub fn call_fn1(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1) }
    pub fn call_fn1_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_RET) }
    pub fn call_fn1_ret_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_RET_I64) }
    pub fn call_fn1_f32_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_F32_RET) }
    pub fn call_fn1_f64_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN1_F64_RET) }
    pub fn call_fn2(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2) }
    pub fn call_fn2_i32_i64(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_I32_I64) }
    pub fn call_fn2_i64_i32(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_I64_I32) }
    pub fn call_fn2_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN2_I64_I32_RET)
    }
    pub fn call_fn2_i64_i32_ret_i64(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN2_I64_I32_RET_I64)
    }
    pub fn call_fn2_f32_i32(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_F32_I32) }
    pub fn call_fn2_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN2_RET) }
    pub fn call_fn3(&mut self, name: &str) { self.call_fn(name, FunctionType::FN3) }
    pub fn call_fn3_ret(&mut self, name: &str) { self.call_fn(name, FunctionType::FN3_RET) }
    pub fn call_fn3_i64_i32_i32(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I64_I32_I32)
    }
    pub fn call_fn3_i32_i64_i32(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I32_I64_I32)
    }
    pub fn call_fn3_i32_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN3_I32_I64_I32_RET)
    }
    pub fn call_fn4_i32_i64_i64_i32_ret(&mut self, name: &str) {
        self.call_fn(name, FunctionType::FN4_I32_I64_I64_I32_RET)
    }

    pub fn unreachable(&mut self) { self.instruction_body.push(op::OP_UNREACHABLE) }

    pub fn instruction_body_length(&self) -> u32 { self.instruction_body.len() as u32 }

    // ---- XWAH-9 Phase 3 (option A): multi-memory emitters, inert in the default build ----
    // Nothing below is called by the shipping JIT; it exists for the Stage 4
    // `guest-ram-import` build and is exercised by the unit tests. It is
    // deliberately placed at the end of the file (below every panic site
    // above) so the default artifact stays byte-identical: panic Location
    // records embed the line numbers of the code above.

    /// Make finish() import guest RAM as a second memory "e"."g" (memory index
    /// GUEST_MEMORY_INDEX), directly after the module memory import "e"."m".
    /// Shared and non-shared variants both declare a maximum: shared memories
    /// require one, and engines reject shared/non-shared import mismatches at
    /// link time, so the non-COI path needs the explicit non-shared form.
    /// Builder-level configuration: it deliberately survives reset(). When
    /// never called, module output is byte-identical to the single-memory form.
    #[cfg(any(test, feature = "guest-ram-import"))]
    #[allow(dead_code)]
    pub fn set_guest_memory_import(&mut self, min_pages: u32, max_pages: u32, shared: bool) {
        dbg_assert!(min_pages <= max_pages);
        dbg_assert!(max_pages <= 0x10000); // wasm32 limit of 4 GiB
        self.guest_memory_import = Some((min_pages, max_pages, shared));
    }

    /// The guest-memory import finish() actually writes. In test builds this
    /// is whatever set_guest_memory_import configured (None = single-memory
    /// module, so the existing builder tests keep passing). In the real
    /// `guest-ram-import` build every generated module must import guest RAM,
    /// so an unconfigured builder falls back to the permissive declared
    /// limits (import subtyping accepts any actual memory whose maximum is
    /// <= the declared maximum, exactly like gram.wasm's import) with the
    /// runtime shared-ness flag set by JS via set_guest_memory_shared.
    #[cfg(any(test, feature = "guest-ram-import"))]
    fn effective_guest_memory_import(&self) -> Option<(u32, u32, bool)> {
        #[cfg(all(feature = "guest-ram-import", not(test)))]
        return Some(self.guest_memory_import.unwrap_or((
            GUEST_MEMORY_IMPORT_MIN_PAGES,
            GUEST_MEMORY_IMPORT_MAX_PAGES,
            unsafe { GUEST_MEMORY_SHARED },
        )));
        #[cfg(not(all(feature = "guest-ram-import", not(test))))]
        self.guest_memory_import
    }

    #[allow(dead_code)]
    fn write_guest_memory_import(&mut self, min_pages: u32, max_pages: u32, shared: bool) {
        let old_len = self.output.len();

        self.output.push(1);
        self.output.push('e' as u8);
        self.output.push(1);
        self.output.push('g' as u8);

        self.output.push(op::EXT_MEMORY);

        if shared {
            self.output.push(op::MEM_LIMITS_SHARED_HAS_MAX);
        }
        else {
            self.output.push(op::MEM_LIMITS_HAS_MAX);
        }
        write_leb_u32(&mut self.output, min_pages);
        write_leb_u32(&mut self.output, max_pages);

        let entry_size = self.output.len() - old_len;

        let new_import_count = self.import_count + 1;
        self.set_import_count(new_import_count);

        let new_table_size = self.import_table_size + entry_size;
        self.set_import_table_size(new_table_size);
    }

    // guest-memory-aware twin of the cfg(not(...)) write_export_section above,
    // kept in sync with it: when the guest memory import is present, the
    // exported function index has to skip one more memory import
    #[cfg(any(test, feature = "guest-ram-import"))]
    pub fn write_export_section(&mut self) {
        self.output.push(op::SC_EXPORT);
        self.output.push(1 + 1 + 1 + 1 + 2); // size of this section
        self.output.push(1); // count of table: just one function exported

        self.output.push(1); // length of exported function name
        self.output.push('f' as u8); // function name
        self.output.push(op::EXT_FUNCTION);

        // index of the exported function
        // function space starts with imports. index of last import is import count - 1
        // the last imports however are memories (the module memory, optionally followed by the
        // guest memory), so we subtract those. Must mirror finish()'s
        // effective_guest_memory_import decision, not the raw field
        let memory_import_count = 1 + self.effective_guest_memory_import().is_some() as u16;
        let next_op_idx = self.output.len();
        self.output.push(0);
        self.output.push(0); // add 2 bytes for writing 16 byte val
        write_fixed_leb16_at_idx(
            &mut self.output,
            next_op_idx,
            self.import_count - memory_import_count,
        );
    }

    // Guest-memory (memory index GUEST_MEMORY_INDEX) variants of the emitters
    // used by the gen_safe_read/gen_safe_write fast paths. The aligned
    // load/store emitters have no guest variants: they only ever address
    // per-instance state (registers, tlb_data, scratch), which stays memory 0

    fn write_guest_memarg(&mut self, align: u8, byte_offset: u32) {
        self.instruction_body.push(align | op::MEM_MULTI_MEMORY);
        self.instruction_body.push(GUEST_MEMORY_INDEX); // 1-byte leb
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    #[allow(dead_code)]
    pub fn load_u8_from_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD8U);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn load_unaligned_u16_from_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD16U);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn load_unaligned_i32_from_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32LOAD);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn load_unaligned_i64_from_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64LOAD);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn store_u8_to_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE8);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn store_unaligned_u16_to_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE16);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn store_unaligned_i32_to_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I32STORE);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    #[allow(dead_code)]
    pub fn store_unaligned_i64_to_guest(&mut self, byte_offset: u32) {
        self.instruction_body.push(op::OP_I64STORE);
        self.write_guest_memarg(op::MEM_NO_ALIGN, byte_offset);
    }

    // Atomic instructions (threads proposal, 0xFE-prefixed), memory-index
    // parametrized. Inert until Phase 4 makes the x86 LOCK prefix real; the
    // i32 rmw family below covers the LOCK-able x86 ops (ADD, SUB/DEC/NEG,
    // AND, OR, XOR, XCHG/XADD, CMPXCHG) at 8/16/32 bit. Atomic accesses
    // require exact natural alignment, so the align field is fixed per width

    fn write_atomic_memarg(&mut self, align: u8, memidx: u8, byte_offset: u32) {
        if memidx == 0 {
            self.instruction_body.push(align);
        }
        else {
            dbg_assert!(memidx < 0x80);
            self.instruction_body.push(align | op::MEM_MULTI_MEMORY);
            self.instruction_body.push(memidx); // 1-byte leb
        }
        write_leb_u32(&mut self.instruction_body, byte_offset);
    }

    fn atomic_op(&mut self, subopcode: u8, align: u8, memidx: u8, byte_offset: u32) {
        self.instruction_body.push(op::OP_ATOMIC_PREFIX);
        self.instruction_body.push(subopcode);
        self.write_atomic_memarg(align, memidx, byte_offset);
    }

    #[allow(dead_code)]
    pub fn atomic_fence(&mut self) {
        self.instruction_body.push(op::OP_ATOMIC_PREFIX);
        self.instruction_body.push(op::OP_ATOMICFENCE);
        self.instruction_body.push(0); // reserved, must be zero
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_add_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(op::OP_I32ATOMICRMWADD, op::MEM_ALIGN32, memidx, byte_offset);
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_add_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16ADDU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_add_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8ADDU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_sub_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(op::OP_I32ATOMICRMWSUB, op::MEM_ALIGN32, memidx, byte_offset);
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_sub_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16SUBU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_sub_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8SUBU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_and_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(op::OP_I32ATOMICRMWAND, op::MEM_ALIGN32, memidx, byte_offset);
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_and_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16ANDU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_and_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8ANDU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_or_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(op::OP_I32ATOMICRMWOR, op::MEM_ALIGN32, memidx, byte_offset);
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_or_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16ORU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_or_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8ORU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_xor_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(op::OP_I32ATOMICRMWXOR, op::MEM_ALIGN32, memidx, byte_offset);
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_xor_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16XORU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_xor_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8XORU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_xchg_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMWXCHG,
            op::MEM_ALIGN32,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_xchg_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16XCHGU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_xchg_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8XCHGU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }

    #[allow(dead_code)]
    pub fn atomic_rmw_cmpxchg_i32(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMWCMPXCHG,
            op::MEM_ALIGN32,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_cmpxchg_u16(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW16CMPXCHGU,
            op::MEM_ALIGN16,
            memidx,
            byte_offset,
        );
    }
    #[allow(dead_code)]
    pub fn atomic_rmw_cmpxchg_u8(&mut self, memidx: u8, byte_offset: u32) {
        self.atomic_op(
            op::OP_I32ATOMICRMW8CMPXCHGU,
            op::MEM_NO_ALIGN,
            memidx,
            byte_offset,
        );
    }
}

// By convention guest RAM is the second memory of generated modules (imported
// as "e"."g" via set_guest_memory_import), the module's own memory being
// memory 0 (XWAH-9 Phase 3, option A)
#[allow(dead_code)]
pub const GUEST_MEMORY_INDEX: u8 = 1;

// Declared limits of the guest-memory import when the `guest-ram-import`
// build generates JIT modules: like gram.wasm's import, declare the widest
// range (min 0, max 4 GiB) so one declaration links against every actual
// guest memory size (import subtyping: actual.min >= declared.min and
// actual.max <= declared.max)
#[cfg(all(feature = "guest-ram-import", not(test)))]
const GUEST_MEMORY_IMPORT_MIN_PAGES: u32 = 0;
#[cfg(all(feature = "guest-ram-import", not(test)))]
const GUEST_MEMORY_IMPORT_MAX_PAGES: u32 = 0x10000;

/// Whether the actual guest memory is shared. A wasm memory import's
/// shared-ness must match the provided memory exactly (LinkError otherwise),
/// and JIT modules are generated at runtime, so this is a runtime flag, not
/// a compile-time constant. Default: non-shared.
#[cfg(feature = "guest-ram-import")]
static mut GUEST_MEMORY_SHARED: bool = false;

/// Exported to JS: cpu.js calls this during initialisation (Stage 5) when it
/// created the imported guest memory with `shared: true` (cross-origin
/// isolated), before any JIT module is generated. Generated modules then
/// declare their "e"."g" import shared to match.
#[cfg(feature = "guest-ram-import")]
#[no_mangle]
pub unsafe fn set_guest_memory_shared(shared: u32) { GUEST_MEMORY_SHARED = shared != 0 }

// Guest-RAM access emitters for codegen.rs' gen_safe_read/gen_safe_write/
// gen_safe_read_write fast paths. Macros rather than methods or cfg'd
// statements at the call sites: the macro invocation replaces the historical
// emitter call on the same line, so the default build's post-expansion token
// stream and the panic-Location line numbers of everything around it stay
// identical (the same technique as memory.rs' Stage 1 gram macros), while
// the `guest-ram-import` build swaps in the memidx-1 guest-memory emitters.

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_load8 {
    ($builder:expr, $offset:expr) => {
        $builder.load_u8($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_load8 {
    ($builder:expr, $offset:expr) => {
        $builder.load_u8_from_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_load16 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_u16($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_load16 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_u16_from_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_load32 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_i32($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_load32 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_i32_from_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_load64 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_i64($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_load64 {
    ($builder:expr, $offset:expr) => {
        $builder.load_unaligned_i64_from_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_store8 {
    ($builder:expr, $offset:expr) => {
        $builder.store_u8($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_store8 {
    ($builder:expr, $offset:expr) => {
        $builder.store_u8_to_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_store16 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_u16($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_store16 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_u16_to_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_store32 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_i32($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_store32 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_i32_to_guest($offset)
    };
}

#[cfg(not(feature = "guest-ram-import"))]
#[macro_export]
macro_rules! jit_gram_store64 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_i64($offset)
    };
}
#[cfg(feature = "guest-ram-import")]
#[macro_export]
macro_rules! jit_gram_store64 {
    ($builder:expr, $offset:expr) => {
        $builder.store_unaligned_i64_to_guest($offset)
    };
}

#[cfg(test)]
mod tests {
    use super::{FunctionType, WasmBuilder, GUEST_MEMORY_INDEX, WASM_MODULE_ARGUMENT_COUNT};
    use std::fs::File;
    use std::io::Write;

    fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    #[test]
    fn import_table_management() {
        let mut w = WasmBuilder::new();

        assert_eq!(0, w.get_fn_idx("foo", FunctionType::FN0));
        assert_eq!(1, w.get_fn_idx("bar", FunctionType::FN1));
        assert_eq!(0, w.get_fn_idx("foo", FunctionType::FN0));
        assert_eq!(2, w.get_fn_idx("baz", FunctionType::FN2));
    }

    #[test]
    fn builder_test() {
        let mut m = WasmBuilder::new();

        m.call_fn("foo", FunctionType::FN0);
        m.call_fn("bar", FunctionType::FN0);

        let local0 = m.alloc_local(); // for ensuring that reset clears previous locals
        m.free_local(local0);

        m.finish();
        m.reset();

        m.const_i32(2);

        m.call_fn("baz", FunctionType::FN1_RET);
        m.call_fn("foo", FunctionType::FN1);

        m.const_i32(10);
        let local1 = m.alloc_local();
        m.tee_local(&local1); // local1 = 10

        m.const_i32(20);
        m.add_i32();
        let local2 = m.alloc_local();
        m.tee_local(&local2); // local2 = 30

        m.free_local(local1);

        let local3 = m.alloc_local();
        assert_eq!(local3.idx(), WASM_MODULE_ARGUMENT_COUNT);

        m.free_local(local2);
        m.free_local(local3);

        m.const_i32(30);
        m.ne_i32();
        m.if_void();
        m.unreachable();
        m.block_end();

        m.finish();

        let op_ptr = m.get_output_ptr();
        let op_len = m.get_output_len();
        dbg_log!("op_ptr: {:?}, op_len: {:?}", op_ptr, op_len);

        let mut f = File::create("build/dummy_output.wasm").expect("creating dummy_output.wasm");
        f.write_all(&m.output).expect("write dummy_output.wasm");
    }

    #[test]
    fn guest_load_store_encoding() {
        let mut m = WasmBuilder::new();

        let cases: &[(fn(&mut WasmBuilder, u32), u8)] = &[
            (WasmBuilder::load_u8_from_guest, 0x2d),
            (WasmBuilder::load_unaligned_u16_from_guest, 0x2f),
            (WasmBuilder::load_unaligned_i32_from_guest, 0x28),
            (WasmBuilder::load_unaligned_i64_from_guest, 0x29),
            (WasmBuilder::store_u8_to_guest, 0x3a),
            (WasmBuilder::store_unaligned_u16_to_guest, 0x3b),
            (WasmBuilder::store_unaligned_i32_to_guest, 0x36),
            (WasmBuilder::store_unaligned_i64_to_guest, 0x37),
        ];
        for &(emit, opcode) in cases {
            let start = m.instruction_body.len();
            emit(&mut m, 16);
            // memarg: flags (align 0 | multi-memory bit), memidx 1, offset 16
            assert_eq!(&m.instruction_body[start..], &[opcode, 0x40, 0x01, 0x10]);
        }

        // multi-byte leb offset
        let start = m.instruction_body.len();
        m.load_unaligned_i32_from_guest(8192);
        assert_eq!(
            &m.instruction_body[start..],
            &[0x28, 0x40, 0x01, 0x80, 0x40]
        );
    }

    #[test]
    fn atomic_encoding() {
        let mut m = WasmBuilder::new();

        let start = m.instruction_body.len();
        m.atomic_fence();
        assert_eq!(&m.instruction_body[start..], &[0xfe, 0x03, 0x00]);

        // (emitter, 0xFE-prefixed subopcode, natural alignment)
        let cases: &[(fn(&mut WasmBuilder, u8, u32), u8, u8)] = &[
            (WasmBuilder::atomic_rmw_add_i32, 0x1e, 2),
            (WasmBuilder::atomic_rmw_add_u16, 0x21, 1),
            (WasmBuilder::atomic_rmw_add_u8, 0x20, 0),
            (WasmBuilder::atomic_rmw_sub_i32, 0x25, 2),
            (WasmBuilder::atomic_rmw_sub_u16, 0x28, 1),
            (WasmBuilder::atomic_rmw_sub_u8, 0x27, 0),
            (WasmBuilder::atomic_rmw_and_i32, 0x2c, 2),
            (WasmBuilder::atomic_rmw_and_u16, 0x2f, 1),
            (WasmBuilder::atomic_rmw_and_u8, 0x2e, 0),
            (WasmBuilder::atomic_rmw_or_i32, 0x33, 2),
            (WasmBuilder::atomic_rmw_or_u16, 0x36, 1),
            (WasmBuilder::atomic_rmw_or_u8, 0x35, 0),
            (WasmBuilder::atomic_rmw_xor_i32, 0x3a, 2),
            (WasmBuilder::atomic_rmw_xor_u16, 0x3d, 1),
            (WasmBuilder::atomic_rmw_xor_u8, 0x3c, 0),
            (WasmBuilder::atomic_rmw_xchg_i32, 0x41, 2),
            (WasmBuilder::atomic_rmw_xchg_u16, 0x44, 1),
            (WasmBuilder::atomic_rmw_xchg_u8, 0x43, 0),
            (WasmBuilder::atomic_rmw_cmpxchg_i32, 0x48, 2),
            (WasmBuilder::atomic_rmw_cmpxchg_u16, 0x4b, 1),
            (WasmBuilder::atomic_rmw_cmpxchg_u8, 0x4a, 0),
        ];
        for &(emit, subopcode, align) in cases {
            // on the guest memory: flags align|0x40, then memidx, then offset
            let start = m.instruction_body.len();
            emit(&mut m, GUEST_MEMORY_INDEX, 8);
            let expected = [0xfe, subopcode, align | 0x40, 0x01, 0x08];
            assert_eq!(&m.instruction_body[start..], &expected);

            // on memory 0: plain memarg without the multi-memory flag
            let start = m.instruction_body.len();
            emit(&mut m, 0, 8);
            assert_eq!(
                &m.instruction_body[start..],
                &[0xfe, subopcode, align, 0x08]
            );
        }
    }

    #[test]
    fn guest_memory_import() {
        // shared: limits flag 0x03, min/max in pages (2048 -> 80 10, 4096 -> 80 20)
        let mut m = WasmBuilder::new();
        m.set_guest_memory_import(2048, 4096, true);
        m.const_i32(2);
        m.call_fn("foo", FunctionType::FN1);
        m.finish();
        // the guest memory import directly follows the module memory import
        // ("e"."m", flag 0, min 64), making it memory index 1
        #[rustfmt::skip]
        let entries = [
            1, 'e' as u8, 1, 'm' as u8, 2, 0x00, 0x40, // "e"."m"
            1, 'e' as u8, 1, 'g' as u8, 2, 0x03, 0x80, 0x10, 0x80, 0x20, // "e"."g"
        ];
        assert!(find_subsequence(&m.output, &entries).is_some());
        // the exported function index accounts for both memory imports:
        // imports are [foo, "e"."m", "e"."g"], so function "f" is index 1
        assert!(find_subsequence(&m.output, &[1, 'f' as u8, 0, 0x81, 0x00]).is_some());

        // the configuration survives reset (it is builder-level, set once per build mode)
        m.reset();
        m.finish();
        assert!(find_subsequence(&m.output, &entries).is_some());

        // non-shared: limits flag 0x01, still with a maximum
        let mut m = WasmBuilder::new();
        m.set_guest_memory_import(2048, 4096, false);
        m.finish();
        let entry = [1, 'e' as u8, 1, 'g' as u8, 2, 0x01, 0x80, 0x10, 0x80, 0x20];
        assert!(find_subsequence(&m.output, &entry).is_some());
        // without function imports the exported function is index 0
        assert!(find_subsequence(&m.output, &[1, 'f' as u8, 0, 0x80, 0x00]).is_some());

        // not configured: no "e"."g" import
        let mut m = WasmBuilder::new();
        m.finish();
        assert!(find_subsequence(&m.output, &[1, 'e' as u8, 1, 'g' as u8]).is_none());
    }

    #[test]
    fn multimem_builder_test() {
        // Builds modules exercising every guest-memory and atomic emitter and
        // dumps them for engine validation and execution by
        // tests/rust/verify-wasmgen-multimem-output.js (which has to be kept
        // in sync with the addresses and values below)
        for &(shared, path) in &[
            (true, "build/dummy_output_multimem_shared.wasm"),
            (false, "build/dummy_output_multimem_nonshared.wasm"),
        ] {
            let mut m = WasmBuilder::new();
            m.set_guest_memory_import(1, 1, shared);

            m.const_i32(2);
            m.call_fn("foo", FunctionType::FN1);

            // plain stores to the guest memory
            m.const_i32(64);
            m.const_i32(0x11223344);
            m.store_unaligned_i32_to_guest(0);
            m.const_i32(68);
            m.const_i32(0xBEEF);
            m.store_unaligned_u16_to_guest(0);
            m.const_i32(70);
            m.const_i32(0xAB);
            m.store_u8_to_guest(0);
            m.const_i32(72);
            m.const_i64(0x0102030405060708);
            m.store_unaligned_i64_to_guest(0);

            // guest loads, copied into the module's own memory
            m.const_i32(0);
            m.const_i32(64);
            m.load_unaligned_i32_from_guest(0);
            m.store_aligned_i32(0);
            m.const_i32(4);
            m.const_i32(68);
            m.load_unaligned_u16_from_guest(0);
            m.store_aligned_i32(0);
            m.const_i32(8);
            m.const_i32(70);
            m.load_u8_from_guest(0);
            m.store_aligned_i32(0);
            m.const_i32(16);
            m.const_i32(72);
            m.load_unaligned_i64_from_guest(0);
            m.store_aligned_i64(0);

            // atomic rmw on the guest memory; every final value is 42
            let rmw32: &[(fn(&mut WasmBuilder, u8, u32), i32, i32)] = &[
                (WasmBuilder::atomic_rmw_add_i32, 40, 2),
                (WasmBuilder::atomic_rmw_sub_i32, 50, 8),
                (WasmBuilder::atomic_rmw_and_i32, 0xFF, 0x2A),
                (WasmBuilder::atomic_rmw_or_i32, 0x28, 0x02),
                (WasmBuilder::atomic_rmw_xor_i32, 0x68, 0x42),
                (WasmBuilder::atomic_rmw_xchg_i32, 7, 42),
            ];
            let mut addr = 128;
            for &(emit, init, operand) in rmw32 {
                m.const_i32(addr);
                m.const_i32(init);
                m.store_unaligned_i32_to_guest(0);
                m.const_i32(addr);
                m.const_i32(operand);
                emit(&mut m, GUEST_MEMORY_INDEX, 0);
                m.drop_();
                addr += 4;
            }
            m.const_i32(addr);
            m.const_i32(7);
            m.store_unaligned_i32_to_guest(0);
            m.const_i32(addr);
            m.const_i32(7);
            m.const_i32(42);
            m.atomic_rmw_cmpxchg_i32(GUEST_MEMORY_INDEX, 0);
            m.drop_();

            let rmw16: &[(fn(&mut WasmBuilder, u8, u32), i32, i32)] = &[
                (WasmBuilder::atomic_rmw_add_u16, 40, 2),
                (WasmBuilder::atomic_rmw_sub_u16, 50, 8),
                (WasmBuilder::atomic_rmw_and_u16, 0xFF, 0x2A),
                (WasmBuilder::atomic_rmw_or_u16, 0x28, 0x02),
                (WasmBuilder::atomic_rmw_xor_u16, 0x68, 0x42),
                (WasmBuilder::atomic_rmw_xchg_u16, 7, 42),
            ];
            let mut addr = 160;
            for &(emit, init, operand) in rmw16 {
                m.const_i32(addr);
                m.const_i32(init);
                m.store_unaligned_u16_to_guest(0);
                m.const_i32(addr);
                m.const_i32(operand);
                emit(&mut m, GUEST_MEMORY_INDEX, 0);
                m.drop_();
                addr += 4;
            }
            m.const_i32(addr);
            m.const_i32(7);
            m.store_unaligned_u16_to_guest(0);
            m.const_i32(addr);
            m.const_i32(7);
            m.const_i32(42);
            m.atomic_rmw_cmpxchg_u16(GUEST_MEMORY_INDEX, 0);
            m.drop_();

            let rmw8: &[(fn(&mut WasmBuilder, u8, u32), i32, i32)] = &[
                (WasmBuilder::atomic_rmw_add_u8, 40, 2),
                (WasmBuilder::atomic_rmw_sub_u8, 50, 8),
                (WasmBuilder::atomic_rmw_and_u8, 0xFF, 0x2A),
                (WasmBuilder::atomic_rmw_or_u8, 0x28, 0x02),
                (WasmBuilder::atomic_rmw_xor_u8, 0x68, 0x42),
                (WasmBuilder::atomic_rmw_xchg_u8, 7, 42),
            ];
            let mut addr = 192;
            for &(emit, init, operand) in rmw8 {
                m.const_i32(addr);
                m.const_i32(init);
                m.store_u8_to_guest(0);
                m.const_i32(addr);
                m.const_i32(operand);
                emit(&mut m, GUEST_MEMORY_INDEX, 0);
                m.drop_();
                addr += 1;
            }
            m.const_i32(addr);
            m.const_i32(7);
            m.store_u8_to_guest(0);
            m.const_i32(addr);
            m.const_i32(7);
            m.const_i32(42);
            m.atomic_rmw_cmpxchg_u8(GUEST_MEMORY_INDEX, 0);
            m.drop_();

            m.atomic_fence();

            m.finish();

            let mut f = File::create(path).expect(path);
            f.write_all(&m.output).expect(path);
        }
    }
}
