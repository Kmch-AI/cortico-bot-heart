import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemOneClient } from '../../decision/systemone.ts';
import { HttpEmbeddingService, HttpRerankService } from '../../memory/vectors.ts';

let server: Server | null = null;

async function start(): Promise<string> {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += String(chunk); });
    req.on('end', () => {
      const json = body ? JSON.parse(body) as Record<string, unknown> : {};
      const send = (value: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/v1/systemone') {
        send({
          model: 'jev',
          answers: {
            action: { type: 'choice', choice: 'respond', confidence: 0.8, probabilities: { respond: 0.8, silence: 0.1, defer: 0.1 } },
            addressed: { type: 'noul', noul: 0.9 },
            voice: { type: 'noul', noul: 0.1 },
            needs_arbiter: { type: 'noul', noul: 0.1 },
            intent: { type: 'choice', choice: 'acknowledge', confidence: 0.7, probabilities: {} },
            stance: { type: 'choice', choice: 'neutral', confidence: 0.7, probabilities: {} },
            depth: { type: 'score', score: '1', confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
            length: { type: 'choice', choice: 'short', confidence: 0.7, probabilities: {} },
            directness: { type: 'choice', choice: 'neutral', confidence: 0.7, probabilities: {} },
            playfulness: { type: 'score', score: '0', confidence: 0.7, legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' }, probabilities: {} },
          },
        });
        return;
      }
      if (req.url === '/v1/embeddings') {
        const input = Array.isArray(json.input) ? json.input as string[] : [String(json.input ?? '')];
        send({ model: 'bge', data: input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) });
        return;
      }
      if (req.url === '/v1/rerank') {
        const docs = Array.isArray(json.documents) ? json.documents as string[] : [];
        send({ model: 'rerank', results: docs.map((_, index) => ({ index, relevance_score: 1 - index * 0.1 })) });
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('HTTP service contracts', () => {
  it('speaks SystemOne, embeddings and rerank shapes', async () => {
    const baseUrl = await start();
    const client = new SystemOneClient({ baseUrl, model: 'jev', timeoutMs: 1000 });
    const response = await client.ask({
      state: { events: 'hi' },
      questions: {
        action: { type: 'choice', instructions: 'a', criteria: { respond: 'r', silence: 's' } },
        voice: { type: 'noul', instructions: 'v' },
      },
    });
    expect(response.answers.action).toMatchObject({ type: 'choice', choice: 'respond' });

    const embedding = new HttpEmbeddingService({
      baseUrl, embeddingModel: 'bge', rerankModel: 'rerank', dim: 4, timeoutMs: 1000,
    });
    expect(await embedding.embed(['a', 'b'])).toEqual([[1, 0, 0, 0], [1, 0, 0, 0]]);

    const rerank = new HttpRerankService({
      baseUrl, embeddingModel: 'bge', rerankModel: 'rerank', dim: 4, timeoutMs: 1000,
    });
    const scores = await rerank.rerank('q', ['a', 'b'], 2);
    expect(scores?.map((s) => s.id)).toEqual(['0', '1']);
    expect(scores?.[0]?.score).toBeGreaterThan(scores?.[1]?.score ?? 0);
  });
});
