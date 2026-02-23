import { readFileSync, writeFileSync } from "node:fs";

const targetVersion =
	process.env.NEXT_VERSION ?? process.argv[2] ?? process.env.npm_package_version;

if (!targetVersion) {
	throw new Error("Target version is required. Set NEXT_VERSION or pass it as the first argument.");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

manifest.version = targetVersion;
packageJson.version = targetVersion;
versions[targetVersion] = manifest.minAppVersion;

writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync("package.json", `${JSON.stringify(packageJson, null, "\t")}\n`);
writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
