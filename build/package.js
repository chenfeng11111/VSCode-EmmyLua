import { existsSync, mkdirSync, copyFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import decompress from "decompress";
import decompressTarGz from "decompress-targz";
import config from "./config.json" with { type: "json" };
import { downloadTo } from "./util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv;

// Parse --skip-download flag and optional positional platform argument.
const skipDownload = args.includes("--skip-download");
const positionalArgs = args.slice(2).filter(a => !a.startsWith("--"));
const explicitPlatform = positionalArgs[0] || null;

// Map VSCode target → { LS archive filename, binary name, archive extension }
const PLATFORM_MAP = {
    "win32-x64":   { file: "emmylua_ls-win32-x64.zip",              binary: "emmylua_ls.exe", ext: ".zip" },
    "win32-arm64": { file: "emmylua_ls-win32-arm64.zip",            binary: "emmylua_ls.exe", ext: ".zip" },
    "linux-x64":   { file: "emmylua_ls-linux-x64-glibc.2.17.tar.gz", binary: "emmylua_ls",     ext: ".tar.gz" },
    "linux-arm64": { file: "emmylua_ls-linux-aarch64-glibc.2.17.tar.gz", binary: "emmylua_ls", ext: ".tar.gz" },
    "darwin-x64":  { file: "emmylua_ls-darwin-x64.tar.gz",          binary: "emmylua_ls",     ext: ".tar.gz" },
    "darwin-arm64":{ file: "emmylua_ls-darwin-arm64.tar.gz",        binary: "emmylua_ls",     ext: ".tar.gz" },
};

function detectTarget(explicitTarget) {
    // Allow explicit override via command line: node ./build/package.js win32-x64
    if (explicitTarget && PLATFORM_MAP[explicitTarget]) {
        return explicitTarget;
    }
    const plat = process.platform;
    const arch = process.arch === "ia32" ? "x86" : process.arch;
    const target = `${plat}-${arch}`;
    if (PLATFORM_MAP[target]) {
        return target;
    }
    console.error(`Unsupported platform: ${target}`);
    process.exit(1);
}

async function downloadDepends(platformInfo) {
    await Promise.all([
        // EmmyLua Debugger — 5 platforms (always needed for cross-platform VSIX)
        downloadTo(
            `${config.emmyDebuggerUrl}/${config.emmyDebuggerVersion}/linux-x64.zip`,
            "temp/linux-x64.zip"
        ),
        downloadTo(
            `${config.emmyDebuggerUrl}/${config.emmyDebuggerVersion}/darwin-arm64.zip`,
            "temp/darwin-arm64.zip"
        ),
        downloadTo(
            `${config.emmyDebuggerUrl}/${config.emmyDebuggerVersion}/darwin-x64.zip`,
            "temp/darwin-x64.zip"
        ),
        downloadTo(
            `${config.emmyDebuggerUrl}/${config.emmyDebuggerVersion}/win32-x86.zip`,
            "temp/win32-x86.zip"
        ),
        downloadTo(
            `${config.emmyDebuggerUrl}/${config.emmyDebuggerVersion}/win32-x64.zip`,
            "temp/win32-x64.zip"
        ),
        // EmmyLua Language Server — current platform only
        downloadTo(
            `${config.newLanguageServerUrl}/${config.newLanguageServerVersion}/${platformInfo.file}`,
            `temp/${platformInfo.file}`
        ),
    ]);
}

async function extractAll(platformInfo) {
    // Debugger
    await decompress("temp/linux-x64.zip",   "debugger/emmy/linux/");
    await decompress("temp/darwin-x64.zip",  "debugger/emmy/mac/x64/");
    await decompress("temp/darwin-arm64.zip","debugger/emmy/mac/arm64/");
    await decompress("temp/win32-x86.zip",   "debugger/emmy/windows/x86/");
    await decompress("temp/win32-x64.zip",   "debugger/emmy/windows/x64/");

    // Language Server
    const archivePath = `temp/${platformInfo.file}`;
    if (platformInfo.ext === ".tar.gz") {
        await decompress(archivePath, "server/", {
            plugins: [decompressTarGz()],
        });
    } else {
        await decompress(archivePath, "server/");
    }
}

function buildRustLS(platformInfo) {
    const rustDir = join(__dirname, "..", "..", "emmylua-analyzer-rust");
    if (!existsSync(rustDir)) {
        console.warn(`⚠ Rust source dir not found: ${rustDir}`);
        console.warn("  Skipping cargo build, will use downloaded binary.");
        return false;
    }

    console.log(`Building Rust LS in ${rustDir}...`);
    execSync("cargo build --release", { cwd: rustDir, stdio: "inherit" });

    const srcBinary = join(rustDir, "target", "release", platformInfo.binary);
    const destBinary = join("server", platformInfo.binary);

    if (!existsSync(srcBinary)) {
        console.error(`✗ Binary not found after build: ${srcBinary}`);
        process.exit(1);
    }

    copyFileSync(srcBinary, destBinary);
    console.log(`✓ Copied ${platformInfo.binary} → server/`);
    return true;
}

async function main() {
    const target = detectTarget(explicitPlatform);
    const platformInfo = PLATFORM_MAP[target];
    console.log(`\n📦 Packaging EmmyLua-LC for ${target}\n`);

    if (skipDownload) {
        console.log("⏩ --skip-download: Skipping download and extraction.\n");

        // Safety check: verify server/ exists from a previous full build
        if (!existsSync("server")) {
            console.error(
                "✗ --skip-download specified but server/ directory not found."
            );
            console.error(
                "  Run a full build first (without --skip-download), or"
            );
            console.error(
                "  ensure server/ and debugger/ directories already exist."
            );
            process.exit(1);
        }
    } else {
        // 1. Prepare temp directory
        if (!existsSync("temp")) {
            mkdirSync("temp");
        }

        // 2. Download debugger + LS
        console.log("⬇  Downloading debugger and language server...");
        await downloadDepends(platformInfo);
        console.log("✓ Downloads complete\n");

        // 3. Extract
        console.log("📂 Extracting...");
        await extractAll(platformInfo);
        console.log("✓ Extraction complete\n");
    }

    // 4. Build Rust LS from sibling repo
    console.log("🦀 Building Rust language server...");
    buildRustLS(platformInfo);
    console.log("");

    // 5. Package VSIX
    console.log("📦 Running vsce package...");
    execSync(`npx vsce package --target ${target}`, { stdio: "inherit" });
    console.log("\n✓ Package complete!");
}

main().catch(err => {
    console.error("✗ Build failed:", err);
    process.exit(1);
});
