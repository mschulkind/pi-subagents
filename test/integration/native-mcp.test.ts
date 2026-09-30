import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

// Local JSON-RPC server and faux model: no adapter, network, or credentials.
const serverSource = `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 let result={};
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(m.method==='tools/list')result={tools:['ping','secret','hidden'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};
 if(m.method==='tools/call')result={content:[{type:'text',text:m.params.name}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`;

test("foreground and runner children load native MCP and deny unselected nested calls", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "native-mcp-"));
	const agentDir = path.join(cwd, "agent");
	fs.mkdirSync(agentDir);
	const server = path.join(cwd, "server.mjs");
	fs.writeFileSync(server, serverSource);
	fs.mkdirSync(path.join(cwd, ".pi"));
	fs.writeFileSync(
		path.join(cwd, ".pi", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				project: {
					command: process.execPath,
					args: [server],
					exposure: "direct",
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ defaultProjectTrust: "never" }),
	);
	fs.writeFileSync(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				demo: {
					command: process.execPath,
					args: [server],
					exposure: "codemode",
					toolExposure: { hidden: "hidden" },
				},
				demo__other: {
					command: process.execPath,
					args: [server],
					exposure: "codemode",
				},
			},
		}),
	);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		for (const host of process.env.PI_SUBAGENTS_NATIVE_MCP_CHILD
			? (["runner"] as const)
			: (["parent", "runner"] as const)) {
			for (const selector of ["demo/ping", "demo", undefined]) {
				let session: pi.AgentSession | undefined;
				const factory = createDefaultChildSessionFactory({
					loadPiCodingAgent: async () => ({
						...pi,
						createAgentSession: async (options) => {
							const result = await pi.createAgentSession(options);
							session = result.session;
							return result;
						},
					}),
				});
				const launch = buildInProcessChildLaunch({
					cwd,
					host,
					sessionEnabled: false,
					childAgentName: "fixture",
					childIndex: 0,
					inheritProjectContext: false,
					inheritGlobalContext: false,
					inheritSkills: false,
					tools: selector ? ["codemode"] : ["codemode", "mcp__demo__ping"],
					mcpDirectTools: selector ? [selector] : undefined,
					excludeTools: selector === "demo" ? ["mcp__demo__secret"] : undefined,
				});
				const faux = fauxProvider({
					provider: "native-fixture",
					models: [{ id: "local" }],
					tokensPerSecond: 100000,
				});
				faux.setResponses([
					fauxAssistantMessage(
						fauxToolCall("codemode", {
							code: "return await tools.mcp__demo__ping({});",
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						fauxToolCall("codemode", {
							code: "return await tools.mcp__demo__secret({});",
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("finished"),
				]);
				launch.session.hooks.push({
					name: "fixture-provider",
					factory(api) {
						api.registerProvider(faux.provider);
					},
				});
				launch.session.model = "native-fixture/local";
				const child = await factory.create(launch.session);
				try {
					const deadline = Date.now() + 10000;
					while (
						!session!.getAllTools().some((t) => t.name === "mcp__demo__ping") &&
						Date.now() < deadline
					)
						await new Promise((r) => setTimeout(r, 20));
					assert.ok(
						session!.getAllTools().some((t) => t.name === "mcp__demo__ping"),
					);
					// Inspect the actual callable registry, not just model declarations.
					assert.ok(session!.getActiveToolNames().includes("mcp__demo__ping"));
					assert.equal(
						session!
							.getAllTools()
							.some(
								(t) =>
									t.name === "mcp__demo__secret" && t.exposure !== "hidden",
							),
						false,
					);
					assert.equal(
						session!
							.getAllTools()
							.some(
								(t) =>
									t.name === "mcp__demo__hidden" && t.exposure !== "hidden",
							),
						false,
					);
					assert.equal(
						session!
							.getAllTools()
							.some((t) => t.name.startsWith("mcp__project__")),
						false,
					);
					assert.equal(
						session!
							.getAllTools()
							.some(
								(t) =>
									t.name === "mcp__demo__other__ping" &&
									t.exposure !== "hidden",
							),
						false,
					);
					await child.prompt("Exercise the local MCP tools.");
					const results = child.messages.filter((m) => m.role === "toolResult");
					assert.equal(results.length, 2);
					assert.match(JSON.stringify(results[0]), /ping/);
					assert.doesNotMatch(JSON.stringify(results[0]), /Script failed/);
					assert.match(JSON.stringify(results[1]), /Script failed/);
				} finally {
					await child.dispose();
					await factory.dispose();
				}
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// Background sessions must work without the parent's module state. The process
// below uses the runner-host launch contract; supervisor orchestration itself is
// exercised by the full async integration suite.
if (!process.env.PI_SUBAGENTS_NATIVE_MCP_CHILD) {
	test("native MCP runner-host loading works in an isolated child process", () => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_SUBAGENTS_NATIVE_MCP_CHILD: "1",
		};
		delete env.NODE_TEST_CONTEXT;
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--import",
				"./test/support/register-loader.mjs",
				"--test",
				fileURLToPath(import.meta.url),
			],
			{
				cwd: process.cwd(),
				env,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.match(output, /fail 0/);
	});
}
