import type { Step } from '../types';
import type { ExecCtx, ExecResult, NodeRuntime } from './types';
import { clickNode, dblclickNode } from './click';
import { fillNode } from './fill';
import { httpNode } from './http';
import { extractNode } from './extract';
import { scriptNode } from './script';
import { openTabNode, switchTabNode, closeTabNode } from './tabs';
import { scrollNode } from './scroll';
import { dragNode } from './drag';
import { keyNode } from './key';
import { waitNode } from './wait';
import { assertNode } from './assert';
import { navigateNode } from './navigate';
import { ifNode } from './conditional';
import { foreachNode, whileNode } from './loops';
import { executeFlowNode } from './execute-flow';
import {
  handleDownloadNode,
  screenshotNode,
  triggerEventNode,
  setAttributeNode,
  switchFrameNode,
  loopElementsNode,
} from './download-screenshot-attr-event-frame-loop';

const registry = new Map<string, NodeRuntime<any>>([
  ['click', clickNode],
  ['dblclick', dblclickNode],
  ['fill', fillNode],
  ['http', httpNode],
  ['extract', extractNode],
  ['script', scriptNode],
  ['openTab', openTabNode],
  ['switchTab', switchTabNode],
  ['closeTab', closeTabNode],
  ['scroll', scrollNode],
  ['drag', dragNode],
  ['key', keyNode],
  ['wait', waitNode],
  ['assert', assertNode],
  ['navigate', navigateNode],
  ['if', ifNode],
  ['foreach', foreachNode],
  ['while', whileNode],
  ['executeFlow', executeFlowNode],
  ['handleDownload', handleDownloadNode],
  ['screenshot', screenshotNode],
  ['triggerEvent', triggerEventNode],
  ['setAttribute', setAttributeNode],
  ['switchFrame', switchFrameNode],
  ['loopElements', loopElementsNode],
]);

export async function executeStep(ctx: ExecCtx, step: Step): Promise<ExecResult> {
  const rt = registry.get(step.type);
  if (!rt) throw new Error(`unsupported step type: ${String(step.type)}`);
  const v = rt.validate ? rt.validate(step) : { ok: true };
  if (!v.ok) throw new Error((v.errors || []).join(', ') || 'validation failed');
  const out = await rt.run(ctx, step);
  return out || {};
}

export type { ExecCtx, ExecResult, NodeRuntime } from './types';
