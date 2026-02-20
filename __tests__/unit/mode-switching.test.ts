import { describe, it, expect } from "vitest";
import { isSafeBashCommand, hasDangerousRedirect } from "../../src/mode/hooks.js";

describe("isSafeBashCommand", () => {
	describe("safe commands (allowed in plan mode)", () => {
		const safeCmds = [
			"cat README.md",
			"head -20 package.json",
			"tail -f logs.txt",
			"grep -r 'TODO' src/",
			"rg 'pattern' .",
			"find . -name '*.ts'",
			"fd '.ts$'",
			"ls -la",
			"tree src/",
			"pwd",
			"echo hello",
			"wc -l src/index.ts",
			"sort file.txt",
			"diff a.txt b.txt",
			"file package.json",
			"stat src/index.ts",
			"du -sh .",
			"df -h",
			"which node",
			"env",
			"printenv PATH",
			"uname -a",
			"whoami",
			"date",
			"ps aux",
			"uptime",
			"git status",
			"git log --oneline",
			"git diff HEAD",
			"git show HEAD",
			"git branch",
			"git remote -v",
			"git ls-files",
			"npm list",
			"npm ls --depth=0",
			"npm view typescript",
			"npm audit",
			"node --version",
			"python --version",
			"jq '.name' package.json",
			"sed -n '1,10p' file.txt",
			"awk '{print $1}' file.txt",
			"bat src/index.ts",
			"curl https://example.com",
		];

		for (const cmd of safeCmds) {
			it(`allows: ${cmd}`, () => {
				expect(isSafeBashCommand(cmd)).toBe(true);
			});
		}
	});

	describe("destructive commands (blocked in plan mode)", () => {
		const blockedCmds = [
			"rm -rf node_modules",
			"rm file.txt",
			"rmdir old/",
			"mv a.txt b.txt",
			"echo hello > file.txt",
			"echo append >> file.txt",
			"git add .",
			"git commit -m 'test'",
			"git push origin main",
			"git pull",
			"git merge feature",
			"git rebase main",
			"git reset --hard HEAD",
			"git checkout main",
			"git stash",
			"npm install lodash",
			"npm uninstall lodash",
			"sudo apt install something",
			"kill -9 1234",
			"pkill node",
		];

		for (const cmd of blockedCmds) {
			it(`blocks: ${cmd}`, () => {
				expect(isSafeBashCommand(cmd)).toBe(false);
			});
		}
	});

	describe("safe redirects (allowed in plan mode)", () => {
		const safeRedirects = [
			"cat file.txt 2>/dev/null",
			"ls -la 2>/dev/null",
			"grep pattern file 2>/dev/null",
			"cat file.txt 2>&1",
			"find . -name '*.ts' 2>/dev/null",
			"cat file 2> /dev/null",
			"echo test 2>/dev/null",
		];

		for (const cmd of safeRedirects) {
			it(`allows safe redirect: ${cmd}`, () => {
				expect(isSafeBashCommand(cmd)).toBe(true);
			});
		}
	});

	describe("dangerous redirects (blocked in plan mode)", () => {
		const dangerousRedirects = [
			"echo hello > file.txt",
			"cat a.txt > b.txt",
			"echo data >> log.txt",
			"ls > listing.txt",
		];

		for (const cmd of dangerousRedirects) {
			it(`blocks dangerous redirect: ${cmd}`, () => {
				expect(isSafeBashCommand(cmd)).toBe(false);
			});
		}
	});

	describe("unknown commands (blocked by default)", () => {
		const unknownCmds = [
			"python script.py",
			"node server.js",
			"gcc main.c",
			"cargo build",
			"make all",
		];

		for (const cmd of unknownCmds) {
			it(`blocks unknown: ${cmd}`, () => {
				expect(isSafeBashCommand(cmd)).toBe(false);
			});
		}
	});
});

describe("hasDangerousRedirect", () => {
	it("returns false for safe stderr redirects", () => {
		expect(hasDangerousRedirect("cat file 2>/dev/null")).toBe(false);
		expect(hasDangerousRedirect("cmd 2>&1")).toBe(false);
		expect(hasDangerousRedirect("cmd &>/dev/null")).toBe(false);
		expect(hasDangerousRedirect("cmd 2> /dev/null")).toBe(false);
	});

	it("returns true for file-writing redirects", () => {
		expect(hasDangerousRedirect("echo hello > file.txt")).toBe(true);
		expect(hasDangerousRedirect("cat a > b")).toBe(true);
		expect(hasDangerousRedirect("ls > listing.txt")).toBe(true);
	});

	it("returns false for commands with no redirects", () => {
		expect(hasDangerousRedirect("ls -la")).toBe(false);
		expect(hasDangerousRedirect("cat file.txt")).toBe(false);
		expect(hasDangerousRedirect("grep pattern src/")).toBe(false);
	});

	it("returns true for append redirects to files", () => {
		// Note: >> is handled by hasDangerousRedirect since it contains >
		expect(hasDangerousRedirect("echo data >> log.txt")).toBe(true);
	});
});
