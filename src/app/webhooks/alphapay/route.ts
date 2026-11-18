import type { NextRequest } from 'next/server';
import { POST as handleAlphaPayWebhook } from '../../api/alphapay/webhook/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return handleAlphaPayWebhook(request);
}
