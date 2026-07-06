import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODEL = 'gemini-test-model';

const { askGemini, extractMemories, GeminiRateLimitError, GENERIC_FALLBACK_REPLY, MAX_MEMORY_ITEMS, MAX_MEMORY_LENGTH } =
  await import('../src/gemini.js');

function mockFetchOnce(response) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  const restore = () => {
    globalThis.fetch = original;
  };
  restore.calls = calls;
  return restore;
}

const baseArgs = {
  persona: 'Testpersona',
  shortTermMessages: [],
  userMemories: [],
  serverMemories: [],
  currentUserName: 'Alice',
  currentUserMessage: 'Hallo'
};

test('askGemini parst reply, new_user_memories und new_server_memories aus einer erfolgreichen Antwort', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  reply: 'Hallo Alice!',
                  new_user_memories: ['mag Kaffee'],
                  new_server_memories: ['Server dreht sich um Minecraft']
                })
              }
            ]
          }
        }
      ]
    })
  });

  try {
    const result = await askGemini(baseArgs);
    assert.deepEqual(result, {
      reply: 'Hallo Alice!',
      newUserMemories: ['mag Kaffee'],
      newServerMemories: ['Server dreht sich um Minecraft']
    });
  } finally {
    restore();
  }
});

test('askGemini liefert leere Arrays, wenn new_user_memories/new_server_memories fehlen', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'ok' }) }] } }]
    })
  });

  try {
    const result = await askGemini(baseArgs);
    assert.deepEqual(result, { reply: 'ok', newUserMemories: [], newServerMemories: [] });
  } finally {
    restore();
  }
});

test('askGemini gibt eine generische Fallback-Antwort zurueck statt kaputtem Rohtext', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'kein json hier, '.repeat(500) }] } }]
    })
  });

  try {
    const result = await askGemini(baseArgs);
    assert.deepEqual(result, { reply: GENERIC_FALLBACK_REPLY, newUserMemories: [], newServerMemories: [] });
  } finally {
    restore();
  }
});

test('askGemini kappt new_user_memories/new_server_memories auf MAX_MEMORY_ITEMS Eintraege und MAX_MEMORY_LENGTH Zeichen', async () => {
  const longEntry = 'x'.repeat(1000);
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  reply: 'ok',
                  new_user_memories: Array.from({ length: 50 }, () => longEntry),
                  new_server_memories: Array.from({ length: 50 }, () => longEntry)
                })
              }
            ]
          }
        }
      ]
    })
  });

  try {
    const result = await askGemini(baseArgs);
    assert.equal(result.newUserMemories.length, MAX_MEMORY_ITEMS);
    assert.equal(result.newServerMemories.length, MAX_MEMORY_ITEMS);
    for (const m of [...result.newUserMemories, ...result.newServerMemories]) {
      assert.equal(m.length, MAX_MEMORY_LENGTH);
    }
  } finally {
    restore();
  }
});

test('askGemini setzt maxOutputTokens im generationConfig', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: 'ok' }) }] } }]
    })
  });

  try {
    await askGemini(baseArgs);
    const body = JSON.parse(restore.calls[0].options.body);
    assert.equal(typeof body.generationConfig.maxOutputTokens, 'number');
    assert.ok(body.generationConfig.maxOutputTokens > 0);
  } finally {
    restore();
  }
});

test('askGemini wirft GeminiRateLimitError mit retryAfterSeconds bei 429 (kein Tageslimit)', async () => {
  const restore = mockFetchOnce({
    ok: false,
    status: 429,
    text: async () =>
      '{"error": {"message": "quota exceeded", "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "23s"}]}}'
  });

  try {
    await assert.rejects(
      () => askGemini(baseArgs),
      (err) => {
        assert.ok(err instanceof GeminiRateLimitError);
        assert.equal(err.retryAfterSeconds, 23);
        assert.equal(err.isDailyQuota, false);
        assert.equal(err.dailyQuotaLimit, null);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askGemini erkennt Tageslimit anhand quotaId und liest quotaValue aus', async () => {
  const restore = mockFetchOnce({
    ok: false,
    status: 429,
    text: async () =>
      JSON.stringify({
        error: {
          message: 'You exceeded your current quota',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [
                {
                  quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                  quotaValue: '20'
                }
              ]
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '11s' }
          ]
        }
      })
  });

  try {
    await assert.rejects(
      () => askGemini(baseArgs),
      (err) => {
        assert.ok(err instanceof GeminiRateLimitError);
        assert.equal(err.isDailyQuota, true);
        assert.equal(err.dailyQuotaLimit, 20);
        assert.equal(err.retryAfterSeconds, 11);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('askGemini wirft einen normalen Error bei anderen HTTP-Fehlern', async () => {
  const restore = mockFetchOnce({
    ok: false,
    status: 500,
    text: async () => 'internal server error'
  });

  try {
    await assert.rejects(() => askGemini(baseArgs), /Gemini API Fehler \(500\)/);
  } finally {
    restore();
  }
});

test('extractMemories mappt user_id/content und server_memories aus dem Batch-Transcript', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  user_memories: [
                    { user_id: '111', content: 'mag Tee' },
                    { user_id: '222', content: 'arbeitet an einem Discord-Bot' }
                  ],
                  server_memories: ['Server dreht sich um Minecraft']
                })
              }
            ]
          }
        }
      ]
    })
  });

  try {
    const result = await extractMemories({
      persona: 'Testpersona',
      messages: [
        { authorId: '111', authorName: 'Alice', content: 'ich trink grad Tee' },
        { authorId: '222', authorName: 'Bob', content: 'ich bau an meinem Discord-Bot' }
      ]
    });
    assert.deepEqual(result, {
      userMemories: [
        { userId: '111', content: 'mag Tee' },
        { userId: '222', content: 'arbeitet an einem Discord-Bot' }
      ],
      serverMemories: ['Server dreht sich um Minecraft']
    });
  } finally {
    restore();
  }
});

test('extractMemories gibt leere Arrays zurueck, wenn Felder fehlen oder Eintraege ungueltig sind', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [{ text: JSON.stringify({ user_memories: [{ user_id: '111' }, { content: 'ohne user_id' }] }) }]
          }
        }
      ]
    })
  });

  try {
    const result = await extractMemories({ persona: 'Testpersona', messages: [] });
    assert.deepEqual(result, { userMemories: [], serverMemories: [] });
  } finally {
    restore();
  }
});

test('extractMemories gibt leere Arrays bei kaputtem JSON zurueck (kein Fallback wie bei askGemini)', async () => {
  const restore = mockFetchOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: 'kein json' }] } }]
    })
  });

  try {
    const result = await extractMemories({ persona: 'Testpersona', messages: [] });
    assert.deepEqual(result, { userMemories: [], serverMemories: [] });
  } finally {
    restore();
  }
});
