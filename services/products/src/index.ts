import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, SQSRecord } from 'aws-lambda';
import { Client } from 'pg';

import { createHandler } from '@marketplace/service-handler';

const secretsClient = new SecretsManagerClient({});

let cachedCredentials: { username: string; password: string } | null = null;

async function getCredentials() {
  if (cachedCredentials) return cachedCredentials;
  const { SecretString } = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN })
  );
  cachedCredentials = JSON.parse(SecretString!);
  return cachedCredentials!;
}

async function getClient() {
  const { username, password } = await getCredentials();
  const client = new Client({
    host: process.env.DB_ENDPOINT,
    user: username,
    password,
    database: 'products',
    port: 5432,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

async function ensureSchema(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0
    )
  `);
}

function ok(body: unknown, status = 200): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(message: string, status = 500): APIGatewayProxyResult {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) };
}

const httpHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const client = await getClient();
  try {
    await ensureSchema(client);
    const { httpMethod, pathParameters } = event;
    const id = pathParameters?.id;

    if (httpMethod === 'GET' && id) {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [id]);
      return rows.length ? ok(rows[0]) : err('Not found', 404);
    }

    if (httpMethod === 'GET') {
      const { rows } = await client.query('SELECT * FROM products LIMIT 50');
      return ok(rows);
    }

    if (httpMethod === 'POST') {
      const { name, price, stock = 0 } = JSON.parse(event.body ?? '{}');
      if (!name || price == null) return err('name and price are required', 400);
      const { rows } = await client.query(
        'INSERT INTO products (name, price, stock) VALUES ($1, $2, $3) RETURNING *',
        [name, price, stock]
      );
      return ok(rows[0], 201);
    }

    return err('Method not allowed', 405);
  } finally {
    await client.end();
  }
};

const queueHandler = async (record: SQSRecord): Promise<void> => {
  console.log('Products SQS record:', record.body);
};

export const handler = createHandler(httpHandler, queueHandler);
