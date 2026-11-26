import { Modal } from "@rin/ui";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../app/runtime";
import { useColorMode } from "../utils/darkModeUtils";
import { Button } from "./button";

const TURNSTILE_SCRIPT_ID = "rin-turnstile-script";
const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SESSION_STORAGE_KEY = "rin:download-session";

type TurnstileWidgetOptions = {
  sitekey: string;
  theme?: "light" | "dark" | "auto";
  appearance?: "always" | "execute" | "interaction-only";
  callback: (token: string) => void;
  "error-callback"?: () => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  language?: string;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: TurnstileWidgetOptions) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type StoredDownloadSession = {
  session: string;
  expiresAt: number;
};

class DownloadCancelledError extends Error {}

let turnstileLoadPromise: Promise<TurnstileApi> | null = null;
let downloadConfigPromise: Promise<{ enabled: boolean; siteKey?: string } | null> | null = null;

function waitForTurnstile(timeoutMs = 15_000): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      if (window.turnstile) {
        resolve(window.turnstile);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Turnstile timed out"));
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) {
    return Promise.resolve(window.turnstile);
  }
  if (turnstileLoadPromise) {
    return turnstileLoadPromise;
  }

  turnstileLoadPromise = new Promise((resolve, reject) => {
    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onerror = () => {
        turnstileLoadPromise = null;
        reject(new Error("Turnstile failed to load"));
      };
      document.head.appendChild(script);
    }

    waitForTurnstile().then(resolve, (error) => {
      turnstileLoadPromise = null;
      reject(error);
    });
  });

  return turnstileLoadPromise;
}

function loadDownloadConfig() {
  if (!downloadConfigPromise) {
    downloadConfigPromise = client.storage
      .downloadConfig()
      .then(({ data, error }) => {
        if (error || !data) {
          downloadConfigPromise = null;
          return null;
        }
        return data;
      })
      .catch(() => {
        downloadConfigPromise = null;
        return null;
      });
  }
  return downloadConfigPromise;
}

function readStoredSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as Partial<StoredDownloadSession>;
    if (typeof parsed.session !== "string" || typeof parsed.expiresAt !== "number") {
      return undefined;
    }
    if (parsed.expiresAt <= Date.now() + 5_000) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return undefined;
    }

    return parsed.session;
  } catch {
    return undefined;
  }
}

function storeSession(value: StoredDownloadSession) {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in private browsing; the session is still
    // valid for the current download.
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function requestAttachmentFile(url: string, session: string) {
  return fetch(url, {
    method: "GET",
    headers: { "x-download-session": session },
    credentials: "omit",
    mode: "cors",
    cache: "no-store",
  });
}

async function responseErrorMessage(response: Response, fallback: string) {
  try {
    const message = (await response.text()).trim();
    if (message) {
      return message;
    }
  } catch {
    // ignore
  }
  return `${fallback} (${response.status})`;
}

function saveBlob(blob: Blob, fileName: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4_000);
}

function TurnstileChallenge({
  open,
  siteKey,
  theme,
  onToken,
  onCancel,
}: {
  open: boolean;
  siteKey?: string;
  theme: "light" | "dark" | "auto";
  onToken: (token: string) => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const widgetRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !siteKey || !containerRef.current) {
      return;
    }

    let cancelled = false;
    setError(null);

    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) {
          return;
        }
        apiRef.current = api;
        widgetRef.current = api.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          language: i18n.language,
          appearance: "interaction-only",
          callback: (token) => {
            if (!cancelled) {
              onToken(token);
            }
          },
          "error-callback": () => {
            if (!cancelled) {
              setError(t("download_verify.failed"));
            }
          },
          "expired-callback": () => {
            if (!cancelled) {
              setError(t("download_verify.expired"));
            }
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setError(t("download_verify.load_failed"));
        }
      });

    return () => {
      cancelled = true;
      const api = apiRef.current;
      const widgetId = widgetRef.current;
      if (api && widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          // ignore
        }
      }
      apiRef.current = null;
      widgetRef.current = null;
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
    };
  }, [open, siteKey, theme, i18n.language, onToken, t]);

  const reset = () => {
    const api = apiRef.current;
    const widgetId = widgetRef.current;
    if (!api || !widgetId) {
      return;
    }
    setError(null);
    try {
      api.reset(widgetId);
    } catch {
      // ignore
    }
  };

  return (
    <Modal
      isOpen={open}
      onRequestClose={onCancel}
      contentLabel={t("download_verify.title")}
      size="sm"
      panelClassName="p-6"
    >
      <div className="flex w-full flex-col gap-4">
        <h2 className="text-xl font-bold tracking-[-0.02em] t-primary">
          {t("download_verify.title")}
        </h2>
        <p className="text-sm t-secondary">{t("download_verify.description")}</p>
        <div
          ref={containerRef}
          className="flex min-h-[70px] w-full items-center justify-center"
        />
        {error ? (
          <p role="alert" className="text-sm text-red-500">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex w-full flex-row items-center justify-end gap-2">
          {error ? <Button title={t("download_verify.retry")} secondary onClick={reset} /> : null}
          <Button title={t("cancel")} secondary onClick={onCancel} />
        </div>
      </div>
    </Modal>
  );
}

export function AttachmentLink({
  href,
  fileName,
  children,
}: {
  href?: string;
  fileName: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const colorMode = useColorMode();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [challengeSiteKey, setChallengeSiteKey] = useState<string | undefined>();
  const pendingRef = useRef<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  } | null>(null);

  const requestToken = useCallback((siteKey: string) => {
    return new Promise<string>((resolve, reject) => {
      pendingRef.current = { resolve, reject };
      setChallengeSiteKey(siteKey);
    });
  }, []);

  const handleToken = useCallback((token: string) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setChallengeSiteKey(undefined);
    pending?.resolve(token);
  }, []);

  const handleCancel = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setChallengeSiteKey(undefined);
    pending?.reject(new DownloadCancelledError());
  }, []);

  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (busy || !href) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const config = await loadDownloadConfig();
      if (!config?.enabled || !config.siteKey) {
        setError(t("download_verify.not_configured"));
        return;
      }

      const storedSession = readStoredSession();
      if (storedSession) {
        const response = await requestAttachmentFile(href, storedSession);
        if (response.ok) {
          saveBlob(await response.blob(), fileName);
          return;
        }

        if (response.status !== 401) {
          setError(await responseErrorMessage(response, t("download_verify.failed")));
          return;
        }
        clearSession();
      }

      const token = await requestToken(config.siteKey);
      const { data: verified, error: verifyError } = await client.storage.verifyDownload(token);
      if (verifyError || !verified?.session) {
        setError(verifyError?.value || t("download_verify.failed"));
        return;
      }

      storeSession(verified);

      const response = await requestAttachmentFile(href, verified.session);
      if (!response.ok) {
        if (response.status === 401) {
          clearSession();
          setError(t("download_verify.required"));
        } else {
          setError(await responseErrorMessage(response, t("download_verify.failed")));
        }
        return;
      }

      saveBlob(await response.blob(), fileName);
    } catch (downloadError) {
      if (downloadError instanceof DownloadCancelledError) {
        return;
      }
      console.error(downloadError);
      setError(downloadError instanceof Error ? downloadError.message : t("download_verify.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="inline-flex max-w-full flex-col items-start gap-1">
        <a
          href={href}
          download={fileName}
          onClick={handleClick}
          aria-busy={busy}
          className="my-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-black/10 bg-neutral-50 px-3 py-2 text-sm text-neutral-700 no-underline transition-colors hover:bg-neutral-100 dark:border-white/10 dark:bg-neutral-800/60 dark:text-neutral-200 dark:hover:bg-neutral-700"
        >
          <i
            className={`${busy ? "ri-loader-4-line animate-spin" : "ri-file-line"} shrink-0 text-base text-neutral-500`}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate">{children}</span>
          <i className="ri-lock-line shrink-0 text-base text-neutral-500" aria-hidden="true" />
        </a>
        {error ? (
          <span role="alert" className="text-xs text-red-500">
            {error}
          </span>
        ) : null}
      </span>
      <TurnstileChallenge
        open={Boolean(challengeSiteKey)}
        siteKey={challengeSiteKey}
        theme={colorMode === "dark" ? "dark" : "light"}
        onToken={handleToken}
        onCancel={handleCancel}
      />
    </>
  );
}
