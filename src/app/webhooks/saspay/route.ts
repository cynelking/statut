import type { NextRequest } from 'next/server';
import { POST as handleSasPayWebhook } from '../../api/saspay/webhook/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  return handleSasPayWebhook(request);
}
