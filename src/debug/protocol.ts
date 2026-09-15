export type DebugTarget = { targetId: string; pid: number; displayName: string; command?: string; jdwp: { status: "enabled" | "not_enabled" | "unknown"; transport?: string; server?: boolean; suspend?: boolean; address?: string }; attachable: boolean | "unknown"; unavailableReason?: string };

export interface BridgeReply { [key: string]: unknown }

