import type { Flow, RunRecord, NodeBase, Edge } from './types';
import { stepsToDAG, type RRNode, type RREdge } from 'chrome-mcp-shared';
import { NODE_TYPES } from '@/common/node-types';
import { IndexedDbStorage } from './storage/indexeddb-manager';

// design note: simple local storage backed store for flows and run records

// Validate if a type string is a valid NodeType
const VALID_NODE_TYPES = new Set<string>(Object.values(NODE_TYPES));
function isValidNodeType(type: string): boolean {
  return VALID_NODE_TYPES.has(type);
}

// Convert RRNode to NodeBase (ui coordinates are optional, not added here)
function toNodeBase(node: RRNode): NodeBase {
  return {
    id: node.id,
    type: isValidNodeType(node.type) ? (node.type as NodeBase['type']) : NODE_TYPES.SCRIPT,
    config: node.config,
  };
}

// Convert RREdge to Edge
function toEdge(edge: RREdge): Edge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    label: edge.label,
  };
}

/**
 * Filter edges to only keep those whose from/to both exist in nodeIds.
 * Prevents topoOrder crash when edges reference non-existent nodes.
 */
function filterValidEdges(edges: Edge[], nodeIds: Set<string>): Edge[] {
  return edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
}

/**
 * Normalize flow before saving: ensure nodes/edges exist for scheduler compatibility.
 * Only generates DAG from steps if nodes are missing or empty.
 * Preserves existing nodes/edges to avoid overwriting user edits.
 */
function normalizeFlowForSave(flow: Flow): Flow {
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  if (hasNodes) {
    return flow;
  }

  // No nodes - generate from steps
  if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
    return flow;
  }

  const dag = stepsToDAG(flow.steps);
  if (dag.nodes.length === 0) {
    return flow;
  }

  const nodes: NodeBase[] = dag.nodes.map(toNodeBase);
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Validate existing edges: only keep if from/to both exist in new nodes
  // Otherwise fall back to generated chain edges
  let edges: Edge[];
  if (Array.isArray(flow.edges) && flow.edges.length > 0) {
    const validEdges = filterValidEdges(flow.edges, nodeIds);
    edges = validEdges.length > 0 ? validEdges : dag.edges.map(toEdge);
  } else {
    edges = dag.edges.map(toEdge);
  }

  return {
    ...flow,
    nodes,
    edges,
  };
}

export interface PublishedFlowInfo {
  id: string;
  slug: string; // for tool name `flow.<slug>`
  version: number;
  name: string;
  description?: string;
}

/**
 * Check if a flow needs normalization (missing nodes when steps exist).
 */
function needsNormalization(flow: Flow): boolean {
  const hasSteps = Array.isArray(flow.steps) && flow.steps.length > 0;
  const hasNodes = Array.isArray(flow.nodes) && flow.nodes.length > 0;
  return hasSteps && !hasNodes;
}

/**
 * Lazy normalize a flow if needed, and persist the normalized version.
 * This handles legacy flows that only have steps but no nodes.
 */
async function lazyNormalize(flow: Flow): Promise<Flow> {
  if (!needsNormalization(flow)) {
    return flow;
  }
  // Normalize and save back to storage
  const normalized = normalizeFlowForSave(flow);
  try {
    await IndexedDbStorage.flows.save(normalized);
  } catch (e) {
    console.warn('lazyNormalize: failed to save normalized flow', e);
  }
  return normalized;
}

export async function listFlows(): Promise<Flow[]> {
  const flows = await IndexedDbStorage.flows.list();
  // Check if any flows need normalization
  const needsNorm = flows.some(needsNormalization);
  if (!needsNorm) {
    return flows;
  }
  // Normalize flows that need it (in parallel)
  const normalized = await Promise.all(
    flows.map(async (flow) => {
      if (needsNormalization(flow)) {
        return lazyNormalize(flow);
      }
      return flow;
    }),
  );
  return normalized;
}

export async function getFlow(flowId: string): Promise<Flow | undefined> {
  const flow = await IndexedDbStorage.flows.get(flowId);
  if (!flow) return undefined;
  // Lazy normalize if needed
  if (needsNormalization(flow)) {
    return lazyNormalize(flow);
  }
  return flow;
}

export async function saveFlow(flow: Flow): Promise<void> {
  const normalizedFlow = normalizeFlowForSave(flow);
  await IndexedDbStorage.flows.save(normalizedFlow);
}

export async function deleteFlow(flowId: string): Promise<void> {
  await IndexedDbStorage.flows.delete(flowId);
}

export async function listRuns(): Promise<RunRecord[]> {
  return await IndexedDbStorage.runs.list();
}

export async function appendRun(record: RunRecord): Promise<void> {
  const runs = await IndexedDbStorage.runs.list();
  runs.push(record);
  // Trim to keep last 10 runs per flowId to avoid unbounded growth
  try {
    const byFlow = new Map<string, RunRecord[]>();
    for (const r of runs) {
      const list = byFlow.get(r.flowId) || [];
      list.push(r);
      byFlow.set(r.flowId, list);
    }
    const merged: RunRecord[] = [];
    for (const [, arr] of byFlow.entries()) {
      arr.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
      const last = arr.slice(Math.max(0, arr.length - 10));
      merged.push(...last);
    }
    await IndexedDbStorage.runs.replaceAll(merged);
  } catch (e) {
    console.warn('appendRun: trim failed, saving all', e);
    await IndexedDbStorage.runs.replaceAll(runs);
  }
}

export async function listPublished(): Promise<PublishedFlowInfo[]> {
  return await IndexedDbStorage.published.list();
}

export async function publishFlow(flow: Flow, slug?: string): Promise<PublishedFlowInfo> {
  const info: PublishedFlowInfo = {
    id: flow.id,
    slug: slug || toSlug(flow.name) || flow.id,
    version: flow.version,
    name: flow.name,
    description: flow.description,
  };
  await IndexedDbStorage.published.save(info);
  return info;
}

export async function unpublishFlow(flowId: string): Promise<void> {
  await IndexedDbStorage.published.delete(flowId);
}

export function toSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 64);
}

export async function exportFlow(flowId: string): Promise<string> {
  const flow = await getFlow(flowId);
  if (!flow) throw new Error('flow not found');
  return JSON.stringify(flow, null, 2);
}

export async function exportAllFlows(): Promise<string> {
  const flows = await listFlows();
  return JSON.stringify({ flows }, null, 2);
}

export async function importFlowFromJson(json: string): Promise<Flow[]> {
  const parsed = JSON.parse(json);
  const flowsToImport: Flow[] = Array.isArray(parsed?.flows)
    ? parsed.flows
    : parsed?.id && parsed?.steps
      ? [parsed as Flow]
      : [];
  if (!flowsToImport.length) throw new Error('invalid flow json');
  const nowIso = new Date().toISOString();
  for (const f of flowsToImport) {
    const meta = f.meta ?? (f.meta = { createdAt: nowIso, updatedAt: nowIso } as any);
    meta.updatedAt = nowIso;
    await saveFlow(f);
  }
  return flowsToImport;
}

// Scheduling support
export type ScheduleType = 'once' | 'interval' | 'daily';
export interface FlowSchedule {
  id: string; // schedule id
  flowId: string;
  type: ScheduleType;
  enabled: boolean;
  // when: ISO string for 'once'; HH:mm for 'daily'; minutes for 'interval'
  when: string;
  // optional variables to pass when running
  args?: Record<string, any>;
}

export async function listSchedules(): Promise<FlowSchedule[]> {
  return await IndexedDbStorage.schedules.list();
}

export async function saveSchedule(s: FlowSchedule): Promise<void> {
  await IndexedDbStorage.schedules.save(s);
}

export async function removeSchedule(scheduleId: string): Promise<void> {
  await IndexedDbStorage.schedules.delete(scheduleId);
}
