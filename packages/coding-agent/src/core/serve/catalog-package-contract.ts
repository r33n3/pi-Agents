export interface CatalogPackage {
	schemaVersion: "pi.catalog-package.v1";
	version: string;
	kind: "agent" | "team";
	name: string;
	description: string;
	members: Array<{
		id: string;
		name: string;
		description: string;
		role: string;
		instructions: string;
		teamInstructions: string;
		toolRequirements: string[];
		memory: "none" | "notes";
		executor: "session" | "harness";
		permissionPolicy: "read-only" | "workspace-write";
	}>;
	tools: Array<{
		id: string;
		tools: string[];
		capabilities: Array<{ id: string; version: number; approval?: string }>;
		requiresConfiguration: boolean;
	}>;
	team?: {
		supervisorMemberId?: string;
		allowRecruitment: boolean;
		memoryStrategy: "recent" | "team" | "none";
		memoryPolicy?: { retain: string; observationTtlHours: number };
		limits: {
			maxRounds: number;
			maxMessages: number;
			maxConcurrency: number;
			maxDurationMs: number;
			maxTotalTokens: number;
			maxCostUsd: number;
		};
		toolRequirements?: string[];
	};
}

export interface CatalogPackageReview {
	package: CatalogPackage;
	digest: string;
	issues: string[];
	excluded: string[];
}
