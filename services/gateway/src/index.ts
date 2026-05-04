import { SFNClient, StartSyncExecutionCommand } from '@aws-sdk/client-sfn';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import AWSXRay from 'aws-xray-sdk';
import express from 'express';
import Redis from 'ioredis';

const app = express();
app.use(express.json());
app.use(AWSXRay.express.openSegment('marketplace-gateway'));

const PORT = process.env.PORT ?? 80;
const API_GATEWAY_URL = process.env.API_GATEWAY_URL ?? '';
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? '';
const ORDER_SAGA_STATE_MACHINE_ARN = process.env.ORDER_SAGA_STATE_MACHINE_ARN ?? '';
const INVALIDATION_QUEUE_URL = process.env.INVALIDATION_QUEUE_URL ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const PRODUCT_CACHE_TTL = 300; // 5 minutes

const sfn = new SFNClient({ region: REGION });
const sns = new SNSClient({ region: REGION });
const sqs = new SQSClient({ region: REGION });

const redis = new Redis({
  host: process.env.REDIS_HOST!,
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  tls: {},
  lazyConnect: true,
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Sync: list all products — cached by CloudFront at edge
app.get('/products', async (_req, res) => {
  try {
    const response = await fetch(`${API_GATEWAY_URL}products`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});
// @ts-ignore — express 4 + @types/express 5 overload mismatch on param routes

// BFFE: enrich single product with live stock level, cache in Redis (cache-aside)
app.get('/products/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `product:${id}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));
  } catch (_) {}

  try {
    const [productRes, inventoryRes] = await Promise.all([
      fetch(`${API_GATEWAY_URL}products/${id}`),
      fetch(`${API_GATEWAY_URL}inventory/${id}`),
    ]);

    if (!productRes.ok) return res.status(productRes.status).json({ error: 'Product not found' });

    const product = await productRes.json();
    const inventory = inventoryRes.ok ? await inventoryRes.json() : {};
    const enriched = { ...product, stockLevel: inventory.amount ?? 0 };

    await redis.set(cacheKey, JSON.stringify(enriched), 'EX', PRODUCT_CACHE_TTL);
    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Saga: place order via Step Functions (synchronous, waits for result)
app.post('/orders', async (req, res) => {
  try {
    const result = await sfn.send(
      new StartSyncExecutionCommand({
        stateMachineArn: ORDER_SAGA_STATE_MACHINE_ARN,
        input: JSON.stringify(req.body),
      })
    );
    const status = result.status === 'SUCCEEDED' ? 200 : 422;
    res.status(status).json({
      status: result.status,
      output: result.output ? JSON.parse(result.output) : null,
      error: result.error,
    });
  } catch (err) {
    res.status(500).json({ error: 'Order saga failed to start' });
  }
});

// Async: publish inventory restock event to SNS (fire and forget)
app.post('/restock', async (req, res) => {
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: EVENT_BUS_URL,
        Message: JSON.stringify(req.body),
        Subject: 'inventory.restocked',
      })
    );
    res.status(202).json({ message: 'Restock event published' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish restock event' });
  }
});

app.use(AWSXRay.express.closeSegment());

// Background SQS polling — event-driven cache invalidation
async function pollInvalidationQueue() {
  if (!INVALIDATION_QUEUE_URL) return;
  try {
    const { Messages } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: INVALIDATION_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    }));
    for (const msg of Messages ?? []) {
      try {
        const body = JSON.parse(msg.Body ?? '{}') as { productId?: string };
        if (body.productId) {
          await redis.del(`product:${body.productId}`);
          console.log(`Cache invalidated: product:${body.productId}`);
        }
        await sqs.send(new DeleteMessageCommand({
          QueueUrl: INVALIDATION_QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle!,
        }));
      } catch (err) {
        console.error('Failed to process invalidation message', err);
      }
    }
  } catch (err) {
    console.error('SQS polling error', err);
  }
}

app.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
  setInterval(pollInvalidationQueue, 5000);
});
