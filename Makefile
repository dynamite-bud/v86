CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
NASM_TEST_DIR=./tests/nasm

INSTRUCTION_TABLES=src/rust/gen/jit.rs src/rust/gen/jit0f.rs \
		   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs \
		   src/rust/gen/analyzer.rs src/rust/gen/analyzer0f.rs \

# Only the dependencies common to both generate_{jit,interpreter}.js
GEN_DEPENDENCIES=$(filter-out gen/generate_interpreter.js gen/generate_jit.js gen/generate_analyzer.js gen/generate_gram_wasm.js, $(wildcard gen/*.js))
JIT_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_jit.js
INTERPRETER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_interpreter.js
ANALYZER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_analyzer.js

STRIP_DEBUG_FLAG=
ifeq ($(STRIP_DEBUG),true)
STRIP_DEBUG_FLAG=--v86-strip-debug
endif

WASM_OPT ?= false
WASM_BINDGEN ?= wasm-bindgen
VIRTIO_GPU_WGPU_DIR=tools/virtio-gpu-wgpu
VIRTIO_GPU_WGPU_OUT=build/virtio-gpu-wgpu
VIRTIO_GPU_WGPU_JS=$(VIRTIO_GPU_WGPU_OUT)/virtio_gpu_wgpu.js
VIRTIO_GPU_WGPU_WASM=$(VIRTIO_GPU_WGPU_OUT)/virtio_gpu_wgpu_bg.wasm
VIRTIO_GPU_WGPU_FILES=$(VIRTIO_GPU_WGPU_DIR)/Cargo.toml $(VIRTIO_GPU_WGPU_DIR)/Cargo.lock \
	$(wildcard $(VIRTIO_GPU_WGPU_DIR)/src/*)


default: build/v86-debug.wasm
all: build/v86_all.js build/libv86.js build/libv86.mjs build/v86.wasm
all-debug: build/libv86-debug.js build/libv86-debug.mjs build/v86-debug.wasm
browser: build/v86_all.js

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map '%outname%.map'

CLOSURE_FLAGS=\
		--generate_exports\
		--externs src/externs.js\
		--warning_level VERBOSE\
		--jscomp_error accessControls\
		--jscomp_error checkRegExp\
		--jscomp_error checkTypes\
		--jscomp_error checkVars\
		--jscomp_error conformanceViolations\
		--jscomp_error const\
		--jscomp_error constantProperty\
		--jscomp_error deprecated\
		--jscomp_error deprecatedAnnotations\
		--jscomp_error duplicateMessage\
		--jscomp_error es5Strict\
		--jscomp_error externsValidation\
		--jscomp_error globalThis\
		--jscomp_error invalidCasts\
		--jscomp_error misplacedTypeAnnotation\
		--jscomp_error missingProperties\
		--jscomp_error missingReturn\
		--jscomp_error msgDescriptions\
		--jscomp_error nonStandardJsDocs\
		--jscomp_error suspiciousCode\
		--jscomp_error strictModuleDepCheck\
		--jscomp_error typeInvalidation\
		--jscomp_error undefinedVars\
		--jscomp_error unknownDefines\
		--jscomp_error visibility\
		--use_types_for_optimization\
		--assume_function_wrapper\
		--summary_detail_level 3\
		--language_in ECMASCRIPT_2020\
		--language_out ECMASCRIPT_2020

CARGO_FLAGS_SAFE=\
		--target wasm32-unknown-unknown \
		-- \
		-C linker=tools/rust-lld-wrapper \
		-C link-args="--import-table --global-base=4096 $(STRIP_DEBUG_FLAG)" \
		-C link-args="build/softfloat.o" \
		-C link-args="build/zstddeclib.o" \
		--verbose

CARGO_FLAGS=$(CARGO_FLAGS_SAFE) -C target-feature=+bulk-memory -C target-feature=+multivalue -C target-feature=+simd128

CORE_FILES=cjs.js const.js io.js main.js lib.js buffer.js ide.js pci.js floppy.js \
	   dma.js pit.js vga.js ps2.js rtc.js uart.js parallel.js vmware.js \
	   acpi.js iso9660.js \
	   state.js ne2k.js sb16.js virtio.js virtio_console.js virtio_net.js virtio_balloon.js \
	   virtio_gpu.js bus.js log.js cpu.js \
	   elf.js kernel.js
LIB_FILES=9p.js filesystem.js marshall.js
BROWSER_FILES=screen.js keyboard.js clipboard.js mouse.js speaker.js serial.js \
	      network.js starter.js worker_bus.js dummy_screen.js ansi_screen.js \
	      inbrowser_network.js fake_network.js wisp_network.js fetch_network.js \
	      print_stats.js filestorage.js modem.js virtio_gpu_backend.js virtio_gpu_wgpu_backend.js \
	      virtio_gpu_webgpu_backend.js smpctl.js gram_env.js smp_host_core.js \
	      smp_worker_host.js smp_vcpu_host.js
# NOTE: src/browser/vcpu_worker.js (XWAH-9 Phase 4) is deliberately NOT in
# BROWSER_FILES: it is a standalone worker entry point (loaded as its own
# module worker / worker_thread), not part of the bundled library.

RUST_FILES=$(shell find src/rust/ -name '*.rs') \
	   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs \
	   src/rust/gen/jit.rs src/rust/gen/jit0f.rs \
	   src/rust/gen/analyzer.rs src/rust/gen/analyzer0f.rs

CORE_FILES:=$(addprefix src/,$(CORE_FILES))
LIB_FILES:=$(addprefix lib/,$(LIB_FILES))
BROWSER_FILES:=$(addprefix src/browser/,$(BROWSER_FILES))

build/v86_all.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	-ls -lh build/v86_all.js
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all.js\
		--define=DEBUG=false\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js
	ls -lh build/v86_all.js

build/v86_all_debug.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all_debug.js\
		--define=DEBUG=true\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js

build/libv86.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.js\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86.js

build/libv86.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.mjs\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86.mjs

build/libv86-debug.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.js\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86-debug.js

build/libv86-debug.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.mjs\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86-debug.mjs

src/rust/gen/jit.rs: $(JIT_DEPENDENCIES)
	./gen/generate_jit.js --output-dir build/ --table jit
src/rust/gen/jit0f.rs: $(JIT_DEPENDENCIES)
	./gen/generate_jit.js --output-dir build/ --table jit0f

src/rust/gen/interpreter.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter
src/rust/gen/interpreter0f.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f

src/rust/gen/analyzer.rs: $(ANALYZER_DEPENDENCIES)
	./gen/generate_analyzer.js --output-dir build/ --table analyzer
src/rust/gen/analyzer0f.rs: $(ANALYZER_DEPENDENCIES)
	./gen/generate_analyzer.js --output-dir build/ --table analyzer0f

# guest-RAM accessor modules for the multimem build (XWAH-9 Phase 3 Stage 3).
# Stage 5's guest_memory_backend "imported" loads them next to the main
# artifact at runtime; shipping them with release bundles is Stage 6
build/gram.wasm: gen/generate_gram_wasm.js gen/util.js
	./gen/generate_gram_wasm.js --output-dir build/ --variant nonshared
build/gram-shared.wasm: gen/generate_gram_wasm.js gen/util.js
	./gen/generate_gram_wasm.js --output-dir build/ --variant shared

.PHONY: gram-wasm
gram-wasm: build/gram.wasm build/gram-shared.wasm

.PHONY: virtio-gpu-wgpu
.NOTPARALLEL: virtio-gpu-wgpu
virtio-gpu-wgpu: $(VIRTIO_GPU_WGPU_JS) $(VIRTIO_GPU_WGPU_WASM)

$(VIRTIO_GPU_WGPU_JS) $(VIRTIO_GPU_WGPU_WASM): $(VIRTIO_GPU_WGPU_FILES)
	mkdir -p $(VIRTIO_GPU_WGPU_OUT)
	CARGO_TARGET_DIR=$(VIRTIO_GPU_WGPU_DIR)/target cargo build \
		--manifest-path $(VIRTIO_GPU_WGPU_DIR)/Cargo.toml \
		--target wasm32-unknown-unknown --release --locked
	$(WASM_BINDGEN) --target web --no-typescript --out-name virtio_gpu_wgpu \
		--out-dir $(VIRTIO_GPU_WGPU_OUT) \
		$(VIRTIO_GPU_WGPU_DIR)/target/wasm32-unknown-unknown/release/virtio_gpu_wgpu.wasm

build/v86.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86.wasm
	cargo rustc --release $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm
	-$(WASM_OPT) && wasm-opt -O2 --strip-debug build/v86.wasm -o build/v86.wasm
	BLOCK_SIZE=K ls -l build/v86.wasm

build/v86-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-debug.wasm
	cargo rustc $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm
	BLOCK_SIZE=K ls -l build/v86-debug.wasm

build/v86-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release $(CARGO_FLAGS_SAFE)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86-fallback.wasm || true

# multimem build (XWAH-9 Phase 3 Stage 4): guest RAM is an imported second
# wasm memory, reached through gram.wasm's accessor exports (`make gram-wasm`)
# and memidx-1 JIT code. Uses the same cargo artifact path as the default
# build, so a default and a multimem build invalidate each other's cargo
# cache; the copied build/*.wasm artifacts stay distinct.
build/v86-multimem.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-multimem.wasm
	cargo rustc --release --features guest-ram-import $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86-multimem.wasm
	-$(WASM_OPT) && wasm-opt -O2 --strip-debug build/v86-multimem.wasm -o build/v86-multimem.wasm
	BLOCK_SIZE=K ls -l build/v86-multimem.wasm

build/v86-multimem-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-multimem-debug.wasm
	cargo rustc --features guest-ram-import $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-multimem-debug.wasm
	BLOCK_SIZE=K ls -l build/v86-multimem-debug.wasm

debug-with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm || true

with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm || true

watch:
	cargo watch -x 'rustc $(CARGO_FLAGS)' -s 'cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm'

build/softfloat.o: lib/softfloat/softfloat.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DSOFTFLOAT_FAST_INT64 -DINLINE_LEVEL=5 -DSOFTFLOAT_FAST_DIV32TO16 -DSOFTFLOAT_FAST_DIV64TO32 \
	    -o build/softfloat.o \
	    lib/softfloat/softfloat.c

build/zstddeclib.o: lib/zstd/zstddeclib.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DZSTDLIB_VISIBILITY="" \
	    -o build/zstddeclib.o \
	    lib/zstd/zstddeclib.c

clean:
	-rm build/libv86.js
	-rm build/libv86.mjs
	-rm build/libv86-debug.js
	-rm build/libv86-debug.mjs
	-rm build/v86_all.js
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm -rf $(VIRTIO_GPU_WGPU_OUT)
	-rm $(INSTRUCTION_TABLES)
	-rm build/*.map
	-rm build/*.wast
	-rm build/*.o
	$(MAKE) -C $(NASM_TEST_DIR) clean

run:
	python3 -m http.server 2> /dev/null

run-isolated:
	python3 tools/coi-server.py 2> /dev/null

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</code>' ;\
	REPLACE='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	SEARCH='<script src="build/v86_all.js?[a-f0-9]\+"></script>' ;\
	REPLACE='<script src="build/v86_all.js?'$$COMMIT'"></script>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	grep $$COMMIT index.html


$(CLOSURE):
	mkdir -p $(CLOSURE_DIR)
	# don't upgrade until https://github.com/google/closure-compiler/issues/3972 is fixed
	wget -nv -O $(CLOSURE) https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/v20210601/closure-compiler-v20210601.jar

build/integration-test-fs/fs.json: images/buildroot-bzimage68.bin
	mkdir -p build/integration-test-fs/flat
	cp images/buildroot-bzimage68.bin build/integration-test-fs/bzImage
	touch build/integration-test-fs/initrd
	cd build/integration-test-fs && tar cfv fs.tar bzImage initrd
	./tools/fs2json.py build/integration-test-fs/fs.tar --out build/integration-test-fs/fs.json
	./tools/copy-to-sha256.py build/integration-test-fs/fs.tar build/integration-test-fs/flat
	rm build/integration-test-fs/fs.tar build/integration-test-fs/bzImage build/integration-test-fs/initrd

tests: build/v86-debug.wasm build/integration-test-fs/fs.json
	LOG_LEVEL=3 ./tests/full/run.js

tests-release: build/libv86.js build/v86.wasm build/integration-test-fs/fs.json
	TEST_RELEASE_BUILD=1 ./tests/full/run.js

nasmtests: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js

nasmtests-force-jit: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js --force-jit

jitpagingtests: build/v86-debug.wasm
	$(MAKE) -C tests/jit-paging test-jit test-jit-smc
	./tests/jit-paging/run.js
	./tests/jit-paging/run-smc.js

qemutests: build/v86-debug.wasm
	$(MAKE) -C tests/qemu test-i386
	LOG_LEVEL=3 ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

qemutests-release: build/libv86.mjs build/v86.wasm
	$(MAKE) -C tests/qemu test-i386
	TEST_RELEASE_BUILD=1 time ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

kvm-unit-test: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh
	tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/taskswitch.flat
	tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/taskswitch2.flat
	tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/realmode.flat
	CPUS=2 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/smptest.flat

kvm-unit-test-release: build/libv86.mjs build/v86.wasm
	tests/kvm-unit-tests/build.sh
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/taskswitch.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/taskswitch2.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/realmode.flat
	TEST_RELEASE_BUILD=1 CPUS=2 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/smptest.flat

expect-tests: build/v86-debug.wasm build/libwabt.cjs
	make -C tests/expect/tests
	./tests/expect/run.js

devices-test: build/v86-debug.wasm
	./tests/devices/virtio_9p.js
	./tests/devices/virtio_console.js
	./tests/devices/fetch_network.js
	USE_VIRTIO=1 ./tests/devices/fetch_network.js
	./tests/devices/fetch_network_post.js
	./tests/devices/wisp_network.js
	./tests/devices/virtio_balloon.js
	./tests/devices/virtio_gpu.js

acpi-unit-test:
	./tests/unit/acpi.js

pci-unit-test:
	./tests/unit/pci.js

filesystem-unit-test:
	./tests/unit/filesystem_capacity.js
	./tests/unit/filestorage.js

mouse-unit-test:
	./tests/unit/mouse.js

clipboard-unit-test:
	./tests/unit/clipboard.js

virtio-gpu-unit-test:
	node tools/docker/virtio-gpu-color/generate-fixtures.js --check
	./tests/unit/virtio_gpu_protocol.js
	./tests/unit/virtio_gpu_webgpu_backend.js
	./tests/unit/ready_state_snapshot.js

virtio-gpu-test: build/v86-debug.wasm acpi-unit-test pci-unit-test virtio-gpu-unit-test
	./tests/devices/virtio_gpu.js

virtio-gpu-test-release: build/libv86.mjs build/v86.wasm acpi-unit-test pci-unit-test virtio-gpu-unit-test
	TEST_RELEASE_BUILD=1 ./tests/devices/virtio_gpu.js

virtio-gpu-capset-probe-test: build/v86-debug.wasm virtio-gpu-unit-test
	./tests/devices/virtio_gpu_capset_probe.js

virtio-gpu-browser-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu
	./tests/browser/virtio_gpu_acceptance.js

virtio-gpu-codex-browser-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu
	./tests/browser/virtio_gpu_codex_acceptance.js

virtio-gpu-codex-benchmark: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=benchmark \
		V86_CODEX_BROWSER_RENDERERS=wgpu ./tests/browser/virtio_gpu_codex_acceptance.js
virtio-gpu-codex-accelerated-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu ./tests/browser/virtio_gpu_codex_acceptance.js
virtio-gpu-codex-benchmark-accelerated: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=benchmark-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu ./tests/browser/virtio_gpu_codex_acceptance.js

# XWAH-9: the multi-core appliance end to end — four worker vCPUs in a real
# browser, the guest's SMP readiness contract, and a canvas that has to hold
# real content AND change in response to typed input. Needs the multimem
# artifact (worker mode does not load build/v86.wasm) and the image built by
# multicore-ghostty-codex-image.
multicore-ghostty-codex-browser-test: build/libv86.mjs build/v86-multimem.wasm \
		build/gram.wasm build/gram-shared.wasm
	./tests/browser/multicore_ghostty_codex_acceptance.js

# Four worker vCPUs plus the pinned webgpuvirt guest and Rust/Wasm wgpu host.
# This is the combined high-performance CPU/GPU appliance, not either
# single-axis regression fixture.
virtio-gpu-multi-core-alpine-codex-browser-test: build/libv86.mjs \
		build/v86-multimem.wasm build/gram.wasm build/gram-shared.wasm \
		virtio-gpu-wgpu virtio-gpu-multi-core-alpine-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_TIMEOUT_MS=600000 \
		V86_CODEX_BROWSER_SCENARIO=multi-core-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu ./tests/browser/virtio_gpu_codex_acceptance.js

# XWAH-45: capture a credential-free, compatibility-bound state after Xorg
# and Openbox are ready but before Ghostty owns live webgpuvirt 3D state.
# The ignored zstd state and manifest are served only when snapshot=hosted.
virtio-gpu-multi-core-alpine-codex-hosted-snapshot: build/libv86.mjs \
		build/v86-multimem.wasm build/gram.wasm build/gram-shared.wasm \
		virtio-gpu-wgpu virtio-gpu-multi-core-alpine-codex-image
	@test -n "$$V86_CODEX_RELAY_URL" || \
		(echo "V86_CODEX_RELAY_URL is required to capture a reconnectable snapshot" >&2; exit 1)
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_TIMEOUT_MS=600000 \
		V86_CODEX_BROWSER_SCENARIO=multi-core-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu V86_CODEX_HOSTED_SNAPSHOT=capture \
		./tests/browser/virtio_gpu_codex_acceptance.js

virtio-gpu-multi-core-alpine-codex-hosted-snapshot-test: build/libv86.mjs \
		build/v86-multimem.wasm build/gram.wasm build/gram-shared.wasm \
		virtio-gpu-wgpu
	@test -n "$$V86_CODEX_RELAY_URL" || \
		(echo "V86_CODEX_RELAY_URL is required to verify restored networking" >&2; exit 1)
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_TIMEOUT_MS=600000 \
		V86_CODEX_BROWSER_SCENARIO=multi-core-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu V86_CODEX_HOSTED_SNAPSHOT=restore \
		./tests/browser/virtio_gpu_codex_acceptance.js

TELNYX_RELAY_URL ?= wisps://clawdtalk.com/wisp/ba976e67b8543ce2a046aea5722ceb93d0f2d42414a43b23/
TELNYX_APPLIANCE_PREFIX := virtio-gpu-multi-core-alpine-codex-telnyx-v0.148.0
TELNYX_CODEX_VERSION := 0.148.0

telnyx-experience-build: build/libv86.mjs build/v86-multimem.wasm \
		build/gram.wasm build/gram-shared.wasm virtio-gpu-wgpu \
		virtio-gpu-multi-core-alpine-codex-telnyx-image

telnyx-experience-snapshot: telnyx-experience-build
	V86_CODEX_RELAY_URL="$(TELNYX_RELAY_URL)" \
		V86_CODEX_BROWSER_PAGE=/telnyx-experience/index.html \
		V86_CODEX_APPLIANCE_PREFIX="$(TELNYX_APPLIANCE_PREFIX)" \
		V86_CODEX_EXPECTED_VERSION="$(TELNYX_CODEX_VERSION)" \
		V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_TIMEOUT_MS=600000 \
		V86_CODEX_BROWSER_SCENARIO=multi-core-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu V86_CODEX_HOSTED_SNAPSHOT=capture \
		./tests/browser/virtio_gpu_codex_acceptance.js

telnyx-experience-test: telnyx-experience-build
	V86_CODEX_RELAY_URL="$(TELNYX_RELAY_URL)" \
		V86_CODEX_BROWSER_PAGE=/telnyx-experience/index.html \
		V86_CODEX_APPLIANCE_PREFIX="$(TELNYX_APPLIANCE_PREFIX)" \
		V86_CODEX_EXPECTED_VERSION="$(TELNYX_CODEX_VERSION)" \
		V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_TIMEOUT_MS=600000 \
		V86_CODEX_BROWSER_SCENARIO=multi-core-accelerated \
		V86_CODEX_BROWSER_RENDERERS=wgpu V86_CODEX_HOSTED_SNAPSHOT=restore \
		./tests/browser/virtio_gpu_codex_acceptance.js

telnyx-experience-serve:
	python3 telnyx-experience/server.py --host 127.0.0.1 --port 8082
virtio-gpu-alacritty-codex-browser-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu
	./tests/browser/virtio_gpu_alacritty_codex_acceptance.js
virtio-gpu-color-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu
	V86_GPU_COLOR_PORT=8081 ./tests/browser/virtio_gpu_color.js

virtio-gpu-3d-transport-test: virtio-gpu-unit-test
	CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER=wasm-bindgen-test-runner \
		cargo test --manifest-path tools/virtio-gpu-wgpu/Cargo.toml --target wasm32-unknown-unknown

virtio-gpu-3d-triangle-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=triangle \
		./tests/browser/virtio_gpu_codex_acceptance.js

virtio-gpu-3d-shader-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=shader \
		./tests/browser/virtio_gpu_codex_acceptance.js

virtio-gpu-webgpuvirt-triangle-test: build/libv86.mjs build/v86.wasm virtio-gpu-wgpu virtio-gpu-codex-image
	V86_CODEX_BROWSER_PORT=8082 V86_CODEX_BROWSER_SCENARIO=resources \
		./tests/browser/virtio_gpu_codex_acceptance.js

virtio-gpu-ready-snapshot-test: build/libv86.mjs build/v86.wasm
	V86_GPU_BROWSER_MATRIX=webgpu-js:xorg V86_GPU_BROWSER_SNAPSHOT=1 ./tests/browser/virtio_gpu_acceptance.js

rust-test: $(RUST_FILES) build/gram.wasm build/gram-shared.wasm
	env RUSTFLAGS="-D warnings" RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js
	./tests/rust/verify-wasmgen-multimem-output.js
	./tests/rust/verify-gram-wasm.js

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

.PHONY: threads-test
threads-test: build/gram.wasm build/gram-shared.wasm
	./tests/threads/atomics-exactness.js
	./tests/threads/guest-lock-exactness.js
	./tests/threads/mailbox-protocol.js
	./tests/threads/index-data-pairs.js
	./tests/threads/multimem-instance.js
	./tests/threads/plain-race-vs-atomic.js
	./tests/threads/shared-view-coherence.js
	./tests/threads/worker-skeleton.js
	./tests/threads/machine-in-worker.js
	./tests/threads/vcpu-workers-lock.js
	./tests/threads/vcpu-workers-smp.js
	./tests/threads/worker-save-restore.js
	./tests/threads/worker-reboot.js
	./tests/threads/tso-litmus.js
	./tests/threads/invlpg-storm.js
	./tests/threads/worker-failure.js

# multimem variant (XWAH-9 Phase 3 Stage 5, named by design doc §4 Stage 6):
# the imported-guest-memory backend end-to-end — real guests through the
# public API plus the Layer B cross-thread test (which threads-test skips
# unless the multimem artifact happens to exist; here it is a hard
# dependency). NOTE: the multimem and default builds share the cargo
# artifact path (see build/v86-multimem.wasm above), so this target
# invalidates a previous default build's cargo cache and vice versa — the
# copied build/*.wasm artifacts stay distinct.
.PHONY: multimem-tests
multimem-tests: build/v86-debug.wasm build/v86-multimem-debug.wasm build/gram.wasm build/gram-shared.wasm
	./tests/api/multimem-negative.js
	./tests/api/multimem.js
	./tests/threads/guest-lock-exactness.js
	./tests/threads/multimem-instance.js
	./tests/threads/worker-skeleton.js
	./tests/threads/machine-in-worker.js
	./tests/threads/vcpu-workers-lock.js
	./tests/threads/vcpu-workers-smp.js
	./tests/threads/worker-save-restore.js
	./tests/threads/worker-reboot.js
	./tests/threads/tso-litmus.js
	./tests/threads/invlpg-storm.js
	./tests/threads/worker-failure.js

api-tests: build/v86-debug.wasm filesystem-unit-test
	./tests/api/clean-shutdown.js
	./tests/api/state.js
	./tests/api/reset.js
	./tests/api/floppy.js
	./tests/api/parallel.js
	./tests/api/cdrom-insert-eject.js
	./tests/api/serial.js
	./tests/api/reboot.js
	#./tests/api/reboot-buildroot.js # https://github.com/copy/v86/issues/636
	./tests/api/pic.js
	./tests/api/smp.js
	./tests/api/smp-state.js

all-tests: eslint kvm-unit-test qemutests qemutests-release jitpagingtests api-tests nasmtests nasmtests-force-jit rust-test threads-test tests expect-tests acpi-unit-test pci-unit-test mouse-unit-test virtio-gpu-unit-test multimem-tests
	# Skipping:
	# - devices-test (hangs)
	# multimem-tests runs last: its build/v86-multimem-debug.wasm dependency
	# shares the cargo artifact path with the default build (see the
	# build/v86-multimem.wasm comment), so ordering it after every
	# default-artifact consumer avoids extra cargo cache invalidations

eslint:
	eslint src tests gen lib examples tools

rustfmt: $(RUST_FILES)
	cargo fmt --all -- --check --config fn_single_line=true,control_brace_style=ClosingNextLine

build/capstone-x86.min.js:
	mkdir -p build
	wget -nv -P build https://github.com/AlexAltea/capstone.js/releases/download/v3.0.5-rc1/capstone-x86.min.js

build/libwabt.cjs:
	mkdir -p build
	wget -nv -P build https://github.com/WebAssembly/wabt/archive/1.0.6.zip
	unzip -j -d build/ build/1.0.6.zip wabt-1.0.6/demo/libwabt.js
	mv build/libwabt.js build/libwabt.cjs
	rm build/1.0.6.zip

build/xterm.js:
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.min.js > build/xterm.js
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.js.map > build/xterm.js.map
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/css/xterm.css > build/xterm.css

virtio-gpu-kms-image:
	tools/docker/virtio-gpu-alpine/build.sh

virtio-gpu-desktop-image:
	tools/docker/virtio-gpu-alpine-desktop/build.sh

virtio-gpu-codex-image:
	tools/docker/virtio-gpu-alpine-codex/build.sh
virtio-gpu-alacritty-codex-image:
	tools/docker/virtio-gpu-alpine-alacritty-codex/build.sh

# Builds into images/multicore-ghostty-codex-* — a distinct prefix from
# virtio-gpu-codex-image on purpose: images/ is a shared, gitignored
# directory, so two branches writing one prefix means the last build silently
# wins and the other branch boots a guest it never described.
multicore-ghostty-codex-image:
	tools/docker/multicore-ghostty-codex/build.sh

virtio-gpu-multi-core-alpine-codex-image:
	tools/docker/virtio-gpu-multi-core-alpine-codex/build.sh

virtio-gpu-multi-core-alpine-codex-telnyx-image:
	tools/docker/virtio-gpu-multi-core-alpine-codex/telnyx/build.sh

update-package-json-version:
	git describe --tags --exclude latest | sed 's/-/./' | tr - + | tee build/version
	jq --arg version "$$(cat build/version)" '.version = $$version' package.json > package.json.tmp
	mv package.json.tmp package.json

doc:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	npx typedoc --readme none --customFooterHtml "Commit: <a href='https://github.com/copy/v86/commits/$$COMMIT'><code>$$COMMIT</code></a>" --out ./docs/api ./v86.d.ts

denodoc:
	deno doc --html --name="v86 API" --output=./docs/api ./v86.d.ts

.PHONY: tests acpi-unit-test pci-unit-test mouse-unit-test virtio-gpu-unit-test \
	virtio-gpu-test virtio-gpu-test-release \
	virtio-gpu-codex-browser-test virtio-gpu-codex-accelerated-test \
	virtio-gpu-codex-benchmark virtio-gpu-codex-benchmark-accelerated \
	virtio-gpu-alacritty-codex-browser-test \
	virtio-gpu-3d-transport-test \
	virtio-gpu-3d-triangle-test virtio-gpu-3d-shader-test \
	virtio-gpu-webgpuvirt-triangle-test virtio-gpu-color-test \
	virtio-gpu-kms-image virtio-gpu-desktop-image virtio-gpu-codex-image \
	virtio-gpu-alacritty-codex-image \
	multicore-ghostty-codex-image multicore-ghostty-codex-browser-test \
	virtio-gpu-multi-core-alpine-codex-image \
	virtio-gpu-multi-core-alpine-codex-browser-test \
	virtio-gpu-multi-core-alpine-codex-hosted-snapshot \
	virtio-gpu-multi-core-alpine-codex-hosted-snapshot-test \
	virtio-gpu-multi-core-alpine-codex-telnyx-image \
	telnyx-experience-build telnyx-experience-snapshot \
	telnyx-experience-test telnyx-experience-serve
