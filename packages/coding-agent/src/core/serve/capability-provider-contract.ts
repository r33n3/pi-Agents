import { type Static, Type } from "typebox";
import type { AgentExecutorKind } from "./agent-registry.ts";

const IdentifierSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9.-]{0,127}$" });
const EnvironmentNameSchema = Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" });

export const CapabilityDefinitionSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: Type.Integer({ minimum: 1 }),
		name: Type.String({ minLength: 1 }),
		description: Type.String({ minLength: 1 }),
		category: Type.Union([
			Type.Literal("web"),
			Type.Literal("browser"),
			Type.Literal("files"),
			Type.Literal("communication"),
			Type.Literal("productivity"),
			Type.Literal("data"),
			Type.Literal("developer"),
			Type.Literal("system"),
		]),
		effect: Type.Union([
			Type.Literal("read"),
			Type.Literal("write"),
			Type.Literal("execute"),
			Type.Literal("external-side-effect"),
		]),
		defaultApproval: Type.Union([Type.Literal("never"), Type.Literal("per-run"), Type.Literal("always")]),
	},
	{ additionalProperties: false },
);

export const CapabilityProviderBindingSchema = Type.Object(
	{
		capabilityId: IdentifierSchema,
		capabilityVersion: Type.Integer({ minimum: 1 }),
		toolName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		approvalEnforced: Type.Optional(Type.Boolean()),
		executors: Type.Array(Type.Union([Type.Literal("session"), Type.Literal("harness")])),
	},
	{ additionalProperties: false },
);

export const ProviderConfigurationFieldSchema = Type.Object(
	{
		env: EnvironmentNameSchema,
		label: Type.String({ minLength: 1 }),
		required: Type.Boolean(),
		secret: Type.Boolean(),
		format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("url")])),
		options: Type.Optional(
			Type.Array(
				Type.Object(
					{ value: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) },
					{ additionalProperties: false },
				),
			),
		),
		operatorEditable: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ProviderCapabilityGroupSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
		label: Type.String({ minLength: 1 }),
		capabilityIds: Type.Array(IdentifierSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ProviderAuthenticationManifestSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("environment"), Type.Literal("oauth2"), Type.Literal("plaid-link")]),
		fields: Type.Array(ProviderConfigurationFieldSchema),
		capabilityGroups: Type.Optional(Type.Array(ProviderCapabilityGroupSchema)),
		defaultCapabilityIds: Type.Optional(Type.Array(IdentifierSchema)),
	},
	{ additionalProperties: false },
);

export const CapabilityProviderManifestSchema = Type.Object(
	{
		id: IdentifierSchema,
		name: Type.String({ minLength: 1 }),
		source: Type.String({ minLength: 1 }),
		version: Type.String({ minLength: 1 }),
		permissions: Type.Array(Type.String({ minLength: 1 })),
		connectionRequired: Type.Optional(Type.Boolean()),
		configurationOnly: Type.Optional(Type.Boolean()),
		authentication: Type.Optional(ProviderAuthenticationManifestSchema),
		bindings: Type.Array(CapabilityProviderBindingSchema),
	},
	{ additionalProperties: false },
);

export const CapabilityProviderMetadataSchema = Type.Object(
	{
		definitions: Type.Array(CapabilityDefinitionSchema),
		providers: Type.Array(CapabilityProviderManifestSchema),
	},
	{ additionalProperties: false },
);

export const CapabilityProviderDiscoverySnapshotSchema = Type.Object(
	{
		version: Type.Literal(1),
		sourceDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		definitions: Type.Array(CapabilityDefinitionSchema),
		providers: Type.Array(
			Type.Object(
				{
					...CapabilityProviderManifestSchema.properties,
					digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type CapabilityCategory = Static<typeof CapabilityDefinitionSchema>["category"];
export type CapabilityEffect = Static<typeof CapabilityDefinitionSchema>["effect"];
export type CapabilityApproval = Static<typeof CapabilityDefinitionSchema>["defaultApproval"];
export type CapabilityDefinition = Static<typeof CapabilityDefinitionSchema>;
export type CapabilityProviderBinding = Omit<Static<typeof CapabilityProviderBindingSchema>, "executors"> & {
	executors: AgentExecutorKind[];
};
export type ProviderConfigurationField = Static<typeof ProviderConfigurationFieldSchema>;
export type ProviderCapabilityGroup = Static<typeof ProviderCapabilityGroupSchema>;
export type ProviderAuthenticationManifest = Static<typeof ProviderAuthenticationManifestSchema>;
export type CapabilityProviderManifest = Omit<Static<typeof CapabilityProviderManifestSchema>, "bindings"> & {
	bindings: CapabilityProviderBinding[];
};
export type CapabilityProviderMetadata = {
	definitions: CapabilityDefinition[];
	providers: CapabilityProviderManifest[];
};
export type CapabilityProviderDiscoverySnapshot = Static<typeof CapabilityProviderDiscoverySnapshotSchema>;
