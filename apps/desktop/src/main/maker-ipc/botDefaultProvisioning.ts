import fs from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

export async function markDefaultBotOffered(ownerRoot: string): Promise<void> {
  const receipt = path.join(ownerRoot, 'bots', '.initial-companion');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  try { await fs.writeFile(receipt, '1\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

/** One-time onboarding receipt, deliberately outside any deletable Bot Home. */
export async function provisionDefaultBot(input: {
  ownerRoot: string;
  assertOwner: () => void;
  hasBotHistory: () => Promise<boolean>;
  create: () => Promise<unknown>;
}): Promise<void> {
  input.assertOwner();
  const receipt = path.join(input.ownerRoot, 'bots', '.initial-companion');
  await fs.mkdir(path.dirname(receipt), { recursive: true });
  await withCrossProcessLock(`${receipt}.lock`, { label: 'initial-companion' }, async lock => {
    if (!lock.held) return;
    input.assertOwner();
    try {
      await fs.access(receipt);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Existing users keep their roster, including a decision to remove Cindy.
    // A receipt survives later deletion of every profile and its history.
    const existing = await input.hasBotHistory();
    input.assertOwner();
    if (!existing) await input.create();
    input.assertOwner();
    await markDefaultBotOffered(input.ownerRoot);
  });
}
