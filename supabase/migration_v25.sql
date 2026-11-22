-- Ensure proof RPCs bypass row-level policies while enforcing their own checks.
-- Apply after migration_v24.sql.

alter function public.start_proof(bigint) owner to postgres;
alter function public.submit_proof_stage(bigint, text, text) owner to postgres;
alter function public.review_proof(bigint, integer, boolean) owner to postgres;
alter function public.expire_proofs() owner to postgres;

revoke all on function public.start_proof(bigint) from public, anon;
grant execute on function public.start_proof(bigint) to authenticated;

revoke all on function public.submit_proof_stage(bigint, text, text) from public, anon;
grant execute on function public.submit_proof_stage(bigint, text, text) to authenticated;

revoke all on function public.review_proof(bigint, integer, boolean) from public, anon;
grant execute on function public.review_proof(bigint, integer, boolean) to authenticated;

revoke all on function public.expire_proofs() from public, anon;
grant execute on function public.expire_proofs() to authenticated, service_role;

notify pgrst, 'reload schema';
