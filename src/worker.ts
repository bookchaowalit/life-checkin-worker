export interface Env {
  TELEGRAM_BOT_TOKEN: string; TELEGRAM_CHAT_ID: string; TELEGRAM_WEBHOOK_SECRET: string; EMPIRE_CHECKIN_TOKEN: string;
  HEALTH_ORIGIN: string; TIME_ORIGIN: string; DIARY_ORIGIN: string;
}
export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> { return new Response('not implemented', { status: 501 }); },
  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {},
};
