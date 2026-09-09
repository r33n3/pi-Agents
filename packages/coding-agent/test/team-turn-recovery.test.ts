import { expect, test, vi } from "vitest";
import { recoverTeamTurn } from "../src/core/serve/team-turn-recovery.ts";

test("repairs a missing submission once with all side-effect tools disabled", async () => {
	let submitted: string | undefined;
	let tools = ["write", "email_draft", "submit_team_turn"];
	const prompt = vi.fn(async () => {
		expect(tools).toEqual(["submit_team_turn"]);
		submitted = "observed result";
	});
	await recoverTeamTurn(
		{
			getActiveToolNames: () => tools,
			setActiveToolsByName: (names) => {
				tools = names;
			},
			prompt,
		},
		() => submitted,
	);
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(tools).toEqual(["write", "email_draft", "submit_team_turn"]);
});

test("does not retry an already submitted action", async () => {
	const prompt = vi.fn();
	const setActiveToolsByName = vi.fn();
	await recoverTeamTurn({ getActiveToolNames: () => [], setActiveToolsByName, prompt }, () => "recorded");
	expect(prompt).not.toHaveBeenCalled();
	expect(setActiveToolsByName).not.toHaveBeenCalled();
});

test("stops after one unsuccessful repair and restores tools", async () => {
	const prompt = vi.fn(async () => {});
	const setActiveToolsByName = vi.fn();
	await expect(
		recoverTeamTurn(
			{
				getActiveToolNames: () => ["write", "submit_team_turn"],
				setActiveToolsByName,
				prompt,
			},
			() => undefined,
		),
	).rejects.toThrow("after one repair attempt");
	expect(prompt).toHaveBeenCalledTimes(1);
	expect(setActiveToolsByName).toHaveBeenLastCalledWith(["write", "submit_team_turn"]);
});

test("propagates cancellation or provider failure without another attempt", async () => {
	const prompt = vi.fn(async () => {
		throw new Error("aborted");
	});
	await expect(
		recoverTeamTurn(
			{
				getActiveToolNames: () => [],
				setActiveToolsByName: () => {},
				prompt,
			},
			() => undefined,
		),
	).rejects.toThrow("aborted");
	expect(prompt).toHaveBeenCalledTimes(1);
});
