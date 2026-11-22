import type { User } from '@supabase/supabase-js';

export const ADMIN = '+22896292039';
export const ADMIN_LINK = 'https://wa.me/22896292039';
export const FEE = 500;
export const VIEW_RATE = 3;
export const BOOST_FEES: Record<number, number> = { 24: 500, 48: 1000, 168: 3500 };
export const BOOST_OPTIONS = [24, 48, 168] as const;
export const boostFee = (hours: number) => BOOST_FEES[hours] ?? 0;
export const MIN_WITHDRAW = 200;
export function withdrawalFee(amount: number) {
  if (amount < MIN_WITHDRAW) return 0;
  if (amount < 1000) return 50;
  if (amount < 5000) return 100;
  return 0;
}
export const REF_LEVELS = [100, 30, 10]; // doit correspondre à migration_v4.sql
export const AMB_AT = 10;
export const AMB_BONUS = 150;
export const DAILY_GOAL = 3;        // idem migration_v3.sql
export const DAILY_BONUS = 50;
export const COUNTRIES = ['Togo', 'Bénin', 'Côte d’Ivoire', 'Sénégal', 'Burkina Faso', 'Mali', 'Niger', 'Cameroun', 'Gabon', 'Tchad', 'Congo', 'Guinée-Bissau', 'République centrafricaine', 'Guinée équatoriale'];
export const OPERATORS = ['Orange Money', 'MTN MoMo', 'Moov Money', 'Wave', 'T-Money', 'Flooz'];
export const AVATARS = ['🙂', '😎', '🦁', '🐯', '🦅', '🌟', '💼', '🚀'];

export type Tab = 'f' | 'd' | 'a' | 'm' | 'p';
export type CType = 'img' | 'vid' | 'txt';
export interface Profile { id: string; phone: string; country: string | null; role: 'user' | 'admin'; ref_code: string | null; display_name: string | null; avatar: string | null; credit: number }
export interface Campaign { id: number; owner: string; title: string; type: CType; content: string | null; media_url: string | null; budget: number; spent: number; status: 'pending' | 'active' | 'done'; country: string | null; created_at?: string; boost_hours: number; boost_until: string | null; credit_used: number; wallet_used?: number; admin_created?: boolean; starts_at: string | null; ends_at: string | null; payment_provider?: 'alphapay' | 'wallet' | null; payment_status?: 'pending' | 'paid' | 'failed' | 'review' | null }
export interface Proof {
  id: number; campaign_id: number; user_id: string; image_path: string | null;
  final_image_path?: string | null; posted_at?: string | null; first_submitted_at?: string | null;
  final_submitted_at?: string | null; rejection_reason?: string | null;
  views: number; base_reward?: number; bonus: number; status: 'pending' | 'approved' | 'rejected'; created_at?: string; profiles?: { phone: string } | null
}
export interface Withdrawal { id: number; user_id: string; amount: number; fee?: number; payout_amount?: number; operator: string; status: 'pending' | 'processing' | 'paid' | 'failed'; recipient_country?: string | null; recipient_network?: string | null; recipient_phone?: string | null; saspay_payout_id?: string | null; created_at?: string; profiles?: { phone: string } | null }
export type TransactionKind = 'earning' | 'level_bonus' | 'referral_bonus' | 'daily_bonus' | 'promo_credit' | 'credit_used' | 'credit_refund' | 'wallet_topup' | 'wallet_used' | 'wallet_refund' | 'withdrawal' | 'proof_status';
export type TransactionStatus = 'approved' | 'pending' | 'processing' | 'rejected' | 'paid' | 'failed' | 'credited' | 'used' | 'refunded';
export interface Transaction {
  transaction_id: string;
  kind: TransactionKind;
  title: string | null;
  amount: number;
  status: TransactionStatus;
  occurred_at: string | null;
}
export interface WalletTopupReview {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  country: string;
  provider_transaction_id: string | null;
  verified_net_amount: number | null;
  verified_currency: string | null;
  created_at: string;
}
export interface Data {
  bal: number; walletBalance: number; camps: Campaign[]; proofs: Proof[]; wd: Withdrawal[]; aP: Proof[]; aW: Withdrawal[];
  walletTopupsReview: WalletTopupReview[];
  favs: number[]; myReviews: number[]; ratings: Record<string, { score: number; n: number }>;
}
export interface Ctx {
  user: User; profile: Profile; d: Data;
  reload: () => Promise<void>;
  say: (m: string) => void;
  run: (fn: () => Promise<void>) => void;
  sel: number | null;
  pick: (id: number | null) => void;
  go: (t: Tab) => void;
  goWallet: () => void;
  goCampaigns: () => void;
  toggleFav: (id: number) => void;
}
