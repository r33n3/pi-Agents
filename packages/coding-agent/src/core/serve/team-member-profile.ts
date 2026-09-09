/** A projection of saved configuration, shared by delegation and the member inspector. */
export function teamMemberProfile(
	agent: { id: string; revision: number; name: string; description: string; persona: string; tools: string[] },
	member: { role: string; notes?: string; toolIds?: string[] },
	teamToolIds?: string[],
) {
	return {
		id: agent.id,
		revision: agent.revision,
		name: agent.name,
		description: agent.description,
		role: member.role,
		instructions: agent.persona,
		teamInstructions: member.notes ?? "",
		assignedToolIds: [...(member.toolIds ?? teamToolIds ?? agent.tools)],
		toolSource: member.toolIds !== undefined ? "member" : teamToolIds !== undefined ? "team" : "agent",
	};
}

export type TeamMemberProfile = ReturnType<typeof teamMemberProfile>;
