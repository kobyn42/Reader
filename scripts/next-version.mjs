import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

function getUtcDateVersion(date = new Date()) {
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, "0");
	const day = String(date.getUTCDate()).padStart(2, "0");
	return `${year}.${month}.${day}`;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const baseVersion = getUtcDateVersion();
const escapedBase = escapeRegExp(baseVersion);
const tagPattern = new RegExp(`^${escapedBase}(?:-(\\d+))?$`);

const tagsOutput = execSync("git tag --list", { encoding: "utf8" }).trim();
const tags = tagsOutput.length > 0 ? tagsOutput.split(/\r?\n/) : [];

let hasReleaseForToday = false;
let maxSuffix = 1;

for (const tag of tags) {
	const match = tag.match(tagPattern);
	if (!match) {
		continue;
	}

	hasReleaseForToday = true;
	if (match[1]) {
		const suffix = Number.parseInt(match[1], 10);
		if (Number.isInteger(suffix)) {
			maxSuffix = Math.max(maxSuffix, suffix);
		}
	}
}

const version = hasReleaseForToday ? `${baseVersion}-${Math.max(2, maxSuffix + 1)}` : baseVersion;

if (process.env.GITHUB_OUTPUT) {
	appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}

console.log(version);
