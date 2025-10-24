/**
 * KV store operations for Voice.Assembly.FM signaling server
 */

// Types for KV entries
export interface KVCtrlEntry {
  client_id: string;
  timestamp: number;
  ws_id: string;
}

export interface KVSynthEntry {
  ts: number;
}

export interface KVOperations {
  get: (key: (string | number)[]) => Promise<{ value: any } | null>;
  set: (
    key: (string | number)[],
    value: any,
    options?: { expireIn?: number },
  ) => Promise<void>;
  delete: (key: (string | number)[]) => Promise<void>;
  list: (
    options: { prefix: (string | number)[] },
  ) => AsyncIterable<{ key: (string | number)[]; value: any }>;
}

/**
 * Create KV operations wrapper
 */
export async function createKVOperations(): Promise<KVOperations> {
  const kv = await Deno.openKv();

  return {
    get: async (key: (string | number)[]) => {
      const result = await kv.get(key);
      return result.value ? { value: result.value } : null;
    },

    set: async (
      key: (string | number)[],
      value: any,
      options?: { expireIn?: number },
    ) => {
      await kv.set(key, value, options);
    },

    delete: async (key: (string | number)[]) => {
      await kv.delete(key);
    },

    list: async function* (options: { prefix: (string | number)[] }) {
      for await (const entry of kv.list(options)) {
        yield {
          key: [...entry.key] as (string | number)[],
          value: entry.value,
        };
      }
    },
  };
}

/**
 * Cleanup stale KV entries on startup
 */
export async function cleanupKVOnStartup(): Promise<void> {
  // No-op in multi-edge environments: message keys expire via TTL.
  // Avoid global cleanup that can race across regions.
  console.log("🧹 Skipping global KV cleanup (using TTL-based expiry)");
}

/**
 * Set active controller in KV
 */
export async function setActiveController(
  kv: KVOperations,
  client_id: string,
  ws_id: string,
): Promise<void> {
  const value: KVCtrlEntry = {
    client_id: client_id,
    timestamp: Date.now(),
    ws_id: ws_id,
  };

  console.log(`[SERVER-STATE] Setting active_ctrl in DB to: ${client_id}`);
  await kv.set(["active_ctrl"], value);
  console.log(`👑 ${client_id} is now the active controller`);
}

/**
 * Get active controller from KV
 */
export async function getActiveController(
  kv: KVOperations,
): Promise<KVCtrlEntry | null> {
  const activeCtrlEntry = await kv.get(["active_ctrl"]);
  return activeCtrlEntry?.value as KVCtrlEntry | null;
}

/**
 * Remove active controller from KV
 */
export async function removeActiveController(kv: KVOperations): Promise<void> {
  console.log("[SERVER-STATE] Removing active controller from DB");
  await kv.delete(["active_ctrl"]);
}

/**
 * Register synth in KV with TTL
 */
export async function registerSynth(
  kv: KVOperations,
  client_id: string,
): Promise<void> {
  try {
    await kv.set(["synths", client_id], { ts: Date.now() }, {
      expireIn: 30_000,
    });
    console.log(`📝 Registered synth ${client_id} in KV with 30s TTL`);
  } catch (e) {
    console.error(`[SYNTH-REGISTER] Failed to register ${client_id} in KV:`, e);
    throw e;
  }
}

/**
 * Refresh synth TTL in KV
 */
export async function refreshSynthTTL(
  kv: KVOperations,
  client_id: string,
): Promise<void> {
  try {
    await kv.set(["synths", client_id], { ts: Date.now() }, {
      expireIn: 30_000,
    });
  } catch (e) {
    console.error(`[SYNTH-KA] Failed to refresh TTL for ${client_id}:`, e);
    throw e;
  }
}

/**
 * Remove synth from KV
 */
export async function removeSynth(
  kv: KVOperations,
  client_id: string,
): Promise<void> {
  try {
    await kv.delete(["synths", client_id]);
    console.log(`🗑️ Removed synth ${client_id} from KV`);
  } catch (e) {
    console.error(`[SYNTH-CLEANUP] Failed to delete ${client_id} from KV:`, e);
    throw e;
  }
}

/**
 * Get list of registered synths from KV
 */
export async function getSynthsList(kv: KVOperations): Promise<string[]> {
  const synthsList: string[] = [];

  try {
    const synthEntries = kv.list({ prefix: ["synths"] });
    for await (const entry of synthEntries) {
      const key = entry.key as (string | unknown)[];
      const synthId = String(key[1]);
      if (synthId?.startsWith("synth-")) {
        synthsList.push(synthId);
      }
    }
  } catch (e) {
    console.error("[SYNTHS-LIST] Failed to read KV synth roster:", e);
    throw e;
  }

  return synthsList;
}

/**
 * Queue message for cross-edge delivery
 */
export async function queueMessage(
  kv: KVOperations,
  targetPeerId: string,
  payload: Record<string, unknown>,
  ttlMs = 10_000,
): Promise<void> {
  await kv.set(["messages", targetPeerId, crypto.randomUUID()], payload, {
    expireIn: ttlMs,
  });
}

/**
 * Get queued messages for a client
 */
export async function getQueuedMessages(
  kv: KVOperations,
  client_id: string,
): Promise<Array<{ key: (string | number)[]; value: any }>> {
  const messages: Array<{ key: (string | number)[]; value: any }> = [];

  try {
    const entries = kv.list({ prefix: ["messages", client_id] });
    for await (const entry of entries) {
      messages.push(entry);
    }
  } catch (error) {
    console.error(`🔄 Error getting queued messages for ${client_id}:`, error);
    throw error;
  }

  return messages;
}

/**
 * Delete queued message
 */
export async function deleteQueuedMessage(
  kv: KVOperations,
  key: (string | number)[],
): Promise<void> {
  await kv.delete(key);
}
