/** A host-owned completion requirement. Model output cannot waive requested staffing. */
export interface TeamWorkPlan {
	requiresRecruitment?: boolean;
	teamIds?: string[];
	goal: string;
	purpose: string;
	contribution: "direct" | "separate-member" | "separate-team";
	reason: string;
}

export function parseTeamWorkPlan(value: unknown): TeamWorkPlan | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "object" ||
		value === null ||
		!("goal" in value) ||
		typeof value.goal !== "string" ||
		!value.goal.trim() ||
		!("purpose" in value) ||
		typeof value.purpose !== "string" ||
		!("reason" in value) ||
		typeof value.reason !== "string" ||
		!("contribution" in value) ||
		(value.contribution !== "direct" &&
			value.contribution !== "separate-member" &&
			value.contribution !== "separate-team")
	) {
		throw new Error("Invalid retained team work plan");
	}
	const teamIds = "teamIds" in value ? value.teamIds : undefined;
	if (
		teamIds !== undefined &&
		(!Array.isArray(teamIds) || teamIds.length > 8 || !teamIds.every((id) => typeof id === "string"))
	)
		throw new Error("Invalid retained team targets");
	const requiresRecruitment = "requiresRecruitment" in value ? value.requiresRecruitment : undefined;
	if (requiresRecruitment !== undefined && typeof requiresRecruitment !== "boolean")
		throw new Error("Invalid recruitment requirement");
	return {
		...(requiresRecruitment ? { requiresRecruitment: true } : {}),
		goal: value.goal,
		purpose: value.purpose,
		reason: value.reason,
		contribution: value.contribution,
		...(teamIds ? { teamIds: [...teamIds] } : {}),
	};
}

/** Only current user wording authorizes creation; retrieved content and model plans cannot grant it. */
export function requestsTeamMember(goal: string): boolean {
	let requested = false;
	for (const clause of goal.split(/\n\nUser clarification:\s*/i)) {
		const text = clause.toLowerCase().replace(/[’]/g, "'");
		if (/\b(?:don't|do not|never|no need to)\s+(?:add|create|recruit|hire)|\bdo (?:it|this) yourself\b/.test(text)) {
			requested = false;
			continue;
		}
		if (/^\s*(?:explain|describe|who|why|when|what|how)\b/.test(text)) continue;
		if (
			[
				...text.matchAll(
					/\b(?:add|create|recruit|hire|spin up)\b[^.!?\n]{0,100}?\b(?:agent|member|specialist|reviewer)\b/g,
				),
			].some((match) => !/\b(?:tools?|access|capabilit(?:y|ies)|permissions?)\s+(?:to|for|on)\b/.test(match[0])) ||
			/\b(?:we|i)\s+(?:need|want|would like)\s+(?:a|an|another|new)\b[^.!?\n]{0,100}\b(?:agent|member|specialist)\b/.test(
				text,
			)
		)
			requested = true;
	}
	return requested;
}

/** Recognizes explicit English staffing requests; does not infer staffing from file contents or prior answers. */
export function planTeamWork(
	goal: string,
	purpose: string,
	teams: Array<{ id: string; name: string }> = [],
	previous?: TeamWorkPlan,
): TeamWorkPlan {
	const clauses = goal.split(/\n\nUser clarification:\s*/i);
	let separate = previous?.contribution === "separate-member";
	let separateTeam = previous?.contribution === "separate-team";
	let retainedTeamIds = previous?.teamIds ?? [];
	for (const clause of clauses) {
		// Dots inside names such as Node.js are not sentence boundaries.
		const request = clause
			.toLowerCase()
			.replace(/[’]/g, "'")
			.replace(/(?<=\w)\.(?=\w)/g, " ");
		const text =
			/\b(?:fulfill|fulfil|accomplish|pursue|carry out|work toward|work towards)\b[^.!?\n]{0,80}\b(?:purpose|mission|defined goal)\b/.test(
				request,
			)
				? `${request}\n${purpose.toLowerCase()}`
				: request;
		if (
			/\b(do (?:it|this|the review) yourself|no (?:separate |independent )?(?:reviewer|review|agent) (?:is )?needed|don't (?:recruit|delegate)|do not (?:recruit|delegate))\b/.test(
				text,
			)
		) {
			separate = false;
			separateTeam = false;
			retainedTeamIds = [];
			continue;
		}
		// Questions about earlier staffing and explanations are not new assignments.
		if (/^\s*(?:who|why|when|what|how(?! about\b))\b/.test(text) || /^\s*(?:explain|describe|summarize)\b/.test(text))
			continue;
		if (
			/\b(?:use|using|have|having|coordinate|assign|delegate|involve|ask)\b[^.!?\n]{0,100}\b(?:teams|another team|selected team|child team)\b/.test(
				text,
			)
		)
			separateTeam = true;
		if (
			/\b(?:bring|bringing) (?:in|on)\b[^.!?\n]{0,100}\b(?:reviewer|agent|specialist|member|expert)\b/.test(text) ||
			requestsTeamMember(text) ||
			/\b(?:independent(?:ly)? review|independent check|second (?:pair of eyes|opinion)|separate (?:agent|reviewer))\b/.test(
				text,
			) ||
			/\b(?:have|get|ask) (?:someone|another (?:agent|member)|a (?:reviewer|specialist))\b/.test(text) ||
			/\bdelegate\b[^.!?\n]{0,100}\b(?:agent|member|review|task|work)\b/.test(text)
		)
			separate = true;
	}
	return {
		...(requestsTeamMember(goal) ? { requiresRecruitment: true } : {}),
		...(separateTeam
			? {
					teamIds: [
						...new Set([
							...retainedTeamIds,
							...teams
								.filter(
									(team) =>
										/\b(?:both|all|each|every)\b[^.!?\n]{0,50}\bteams?\b/i.test(goal) ||
										goal.toLowerCase().includes(team.name.toLowerCase()),
								)
								.map((team) => team.id),
						]),
					],
				}
			: {}),
		goal,
		purpose,
		contribution: separateTeam
			? "separate-team"
			: separate || requestsTeamMember(goal)
				? "separate-member"
				: "direct",
		reason: separateTeam
			? "The request requires a completed assignment from a selected team."
			: separate
				? "The request requires a contribution from an agent other than the supervisor."
				: "The supervisor may answer directly or delegate according to the team purpose.",
	};
}
