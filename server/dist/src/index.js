#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runAdvisor } from "./advisor.js";
const ADVISOR_SYSTEM_PROMPT = `You are a senior technical advisor. An AI coding agent working on a task has paused to consult you for strategic guidance. Below is the agent's description of the task, what it has done, and what it needs help with.

Respond in under 100 words using enumerated steps, not explanations. Focus on:

1. Whether the current approach is sound
2. Risks or edge cases being missed
3. Concrete next steps if the agent is stuck
4. Validation if the agent is about to declare done

Be direct. The agent will treat your guidance as authoritative.`;
const TOOL_DESCRIPTION = "Consult a senior technical advisor (a stronger reasoning model) for strategic guidance. Provide your full task context, current approach, and any blockers. The advisor will review your work and respond with enumerated next steps. Use when choosing an approach on a non-trivial task, when stuck, when considering a change of direction, or before declaring done.";
function buildPrompt(context, question) {
    const parts = [
        ADVISOR_SYSTEM_PROMPT,
        "",
        "--- Engineer context ---",
        context.trim(),
    ];
    if (question && question.trim()) {
        parts.push("", "--- Specific question ---", question.trim());
    }
    return parts.join("\n");
}
async function main() {
    const config = loadConfig();
    let callCount = 0;
    const server = new McpServer({
        name: "advisor",
        version: "0.1.0",
    });
    server.registerTool("consult", {
        title: "Consult a senior technical advisor",
        description: TOOL_DESCRIPTION,
        inputSchema: {
            context: z
                .string()
                .min(1)
                .describe("Your current understanding of the task, what you've done so far, your planned approach, and what you need guidance on. Be thorough — the advisor only sees what you provide here."),
            question: z
                .string()
                .optional()
                .describe("Optional specific question if you have one beyond general guidance."),
        },
    }, async ({ context, question }) => {
        if (!config.enabled) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Advisor is disabled (ADVISOR_ENABLED=false). Proceed with your best judgment.",
                    },
                ],
            };
        }
        if (callCount >= config.maxCalls) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Advisor budget exhausted (${config.maxCalls} calls used this session). Proceed with your best judgment, or ask the user to raise ADVISOR_MAX_CALLS if you need more consultations.`,
                    },
                ],
            };
        }
        const prompt = buildPrompt(context, question);
        try {
            const response = await runAdvisor({
                model: config.model,
                prompt,
            });
            callCount += 1;
            return {
                content: [
                    {
                        type: "text",
                        text: response,
                    },
                ],
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [
                    {
                        type: "text",
                        text: `Advisor call failed: ${message}\n\nProceed with your best judgment or retry with more context.`,
                    },
                ],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[bedrock-advisor] stdio server ready (model=${config.model}, maxCalls=${config.maxCalls}, enabled=${config.enabled})\n`);
}
main().catch((err) => {
    process.stderr.write(`[bedrock-advisor] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
});
