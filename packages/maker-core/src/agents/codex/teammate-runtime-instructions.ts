import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

const PREFIX = '<!-- teammate-runtime-context:';
const TAIL_BYTES = 256 * 1024;

/** Native resume config alone does not replace the developer items in a historical thread. */
export function teammateRuntimeInstructionItem(instructions: string) {
  const hash = createHash('sha256').update(instructions).digest('hex');
  const marker = `${PREFIX}${hash} -->`;
  return {
    marker,
    item: {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: `${marker}\nCurrent teammate runtime instructions replace earlier host-provided teammate operating instructions and capability snapshots. Conversation history remains intact.\n\n${instructions}` }],
    },
  };
}

/** Bounded dedupe only. A missing/compacted/unreadable marker means re-deliver, never skip the guide. */
export async function hasCurrentTeammateInstructions(rolloutPath: string | undefined, marker: string): Promise<boolean> {
  if (!rolloutPath) return false;
  let file;
  try {
    file = await open(rolloutPath, 'r');
    const { size } = await file.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const bytes = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type === 'compacted') return false;
      if (row.type !== 'response_item' || row.payload?.role !== 'developer') continue;
      const text = (row.payload.content ?? []).map((part: { text?: string }) => part.text ?? '').join('\n');
      if (text.startsWith(PREFIX)) return text.startsWith(`${marker}\n`);
    }
    return false;
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}
