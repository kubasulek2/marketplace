import { SFNClient, StartSyncExecutionCommand } from '@aws-sdk/client-sfn';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import AWSXRay from 'aws-xray-sdk';
import express from 'express';

const app = express();
app.use(express.json());
app.use(AWSXRay.express.openSegment('marketplace-gateway'));

const PORT = process.env.PORT ?? 80;
const API_GATEWAY_URL = process.env.API_GATEWAY_URL ?? '';
const EVENT_BUS_URL = process.env.EVENT_BUS_URL ?? '';
const ORDER_SAGA_STATE_MACHINE_ARN = process.env.ORDER_SAGA_STATE_MACHINE_ARN ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const sfn = new SFNClient({ region: REGION });
const sns = new SNSClient({ region: REGION });

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Sync: fetch products from internal API GW → Products Lambda → Aurora
app.get('/products', async (_req, res) => {
  try {
    const response = await fetch(`${API_GATEWAY_URL}products`);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Saga: start order saga via Step Functions (sync, waits for result)
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

// Async: publish inventory restock event to SNS
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

app.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
