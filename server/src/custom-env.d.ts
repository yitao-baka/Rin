import type { QueueTask } from "./queue";

declare global {
  interface Env {
    TASK_QUEUE?: Queue<QueueTask>;
    R2_BUCKET?: R2Bucket;
    /** 站点公开访问地址（可选）。未设置时 sitemap/robots 回退到请求来源 origin */
    FRONTEND_URL?: string;
    /** Cloudflare Turnstile 公开 site key（可选）。与 secret key 同时设置时启用附件下载验证 */
    TURNSTILE_SITE_KEY?: string;
    /** Cloudflare Turnstile secret key（仅 Worker 可见） */
    TURNSTILE_SECRET_KEY?: string;
    /** 允许通过 Turnstile 验证的站点 hostname，逗号分隔（可选） */
    TURNSTILE_EXPECTED_HOSTNAME?: string;
  }
}

export {};
