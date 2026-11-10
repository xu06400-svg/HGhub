import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, cover, fmt, fmtTime, mediaUrl, platform } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { sanitizeHtml } from "../html";
import { setBackHandler } from "../back";
import {
  IAspect, IBack, IBoltF, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  ILink, IList, ILockF, IPauseF, IPlayF, IPlus, IReplay, IScreenClean, IShield, ISparkF, IStar, IStarF, IVol, IVolMute,
} from "../icons";

const PREVIEW_LIMIT = 15;

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
};

const RATES = [1, 1.25, 1.5, 2];

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory, user, setLoginOpen, isVip, setVipModalOpen, progress, saveProgress } = store;
  const isDesktop = platform !== "android";

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  const [index, setIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>({});
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [cards, setCards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});
  const resumedKeysRef = useRef<Set<string>>(new Set());
  const notifiedVidsRef = useRef<Set<number>>(new Set());
  const preloadedKeysRef = useRef<Set<string>>(new Set());

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  const [playRetry, setPlayRetry] = useState(0);
  const [vipLocked, setVipLocked] = useState(false);
  const vipLockedRef = useRef(false);
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [cleanScreen, setCleanScreen] = useState(false);
  const [customFit, setCustomFit] = useState<"cover" | "contain" | null>(null);
  const [burstHearts, setBurstHearts] = useState<{ id: number; x: number; y: number; rot: number }[]>([]);
  const lastTapRef = useRef<{ t: number; x: number; y: number }>({ t: 0, x: 0, y: 0 });
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  /* —— 移动端手势 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 进度条拖动 */
  const barRef = useRef<HTMLDivElement>(null);
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub"; base: number; width: number;
  } | null>(null);

  const curId = videoIds[index];
  const detail = details[curId];
  const curEp = epMap[curId] || progress[curId]?.ep || 1;
  const playKey = `${curId}:${curEp}`;
  const playUrl = playUrls[playKey] || "";
  const episodes = detail?.episodes || [];
  const post = posts[curId];

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? sanitizeHtml(post?.content || "") : "";

  /* 倍速：长按 / 锁定 → 2.0x，否则用基准倍速 */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* 进度条显示百分比（拖动时用拖动值） */
  const barProgress = barPct ?? (duration ? time / duration : 0);
  /* 沉浸全屏 + 横屏视频 → 舞台旋转 90°，看起来就是横屏 */
  const rotated = !isDesktop && fs && vsize.w > vsize.h && vsize.h > 0;

  /* 滚动定位 */
  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const i = Math.max(0, Math.min(videoIds.length - 1, Math.round(el.scrollTop / h)));
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [videoIds.length, onNearEnd]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const next = Math.max(0, Math.min(videoIds.length - 1, index + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, videoIds.length]);

  /* 初始定位 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 拉详情（当前 + 邻接预取） */
  useEffect(() => {
    let alive = true;
    const need = [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds]);

  /* 吃瓜帖子：直接拿帖子详情（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  /* 拉播放地址：明确诊断 API 空数据，并允许用户重新请求 */
  useEffect(() => {
    if (!curId || kind !== "video") return;
    if (playUrls[playKey]) return;
    let alive = true;
    setErr("");
    setWaiting(true);
    api.play(curId, curEp)
      .then((info) => {
        if (!alive) return;
        const url = typeof info?.video_url === "string" ? info.video_url.trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          // 仅展示类型、长度及 URL 协议，不展示完整链接、令牌或密钥。
          const record = info && typeof info === "object" ? info as unknown as Record<string, unknown> : {};
          const describe = (name: string): string => {
            const value = record[name];
            if (value === null) return `${name}=null`;
            if (value === undefined) return `${name}=missing`;
            if (typeof value === "string") {
              const trimmed = value.trim();
              const scheme = /^https?:\/\//i.test(trimmed) ? "http(s)" : /^\w+:/.test(trimmed) ? "other-scheme" : "no-scheme";
              return `${name}=string(len:${trimmed.length},${scheme})`;
            }
            if (Array.isArray(value)) return `${name}=array(len:${value.length})`;
            if (typeof value === "object") return `${name}=object(keys:${Object.keys(value as object).length})`;
            return `${name}=${typeof value}`;
          };
          const fields = ["video_url", "video_url_hevc", "video_api", "video_iv", "video_key", "media_id"];
          throw new Error(`播放地址诊断 v2 (id=${curId},ep=${curEp}): ${fields.map(describe).join("; ")}`);
        }
        setPlayUrls((m) => ({ ...m, [playKey]: url }));
        setErr("");
        addHistory(curId);
      })
      .catch((e) => {
        if (alive) {
          setWaiting(false);
          setErr((e as Error).message || "取播放地址失败");
        }
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, kind, playRetry]);

  const retryCurrentVideo = () => {
    setErr("");
    setWaiting(true);
    setPlayUrls((m) => {
      const next = { ...m };
      delete next[playKey];
      return next;
    });
    setPlayRetry((n) => n + 1);
  };

  /* 下一集无缝预加载：当前集开播后，静默预取下一集播放地址并预热底层 m3u8 缓存 */
  useEffect(() => {
    if (!curId || !playUrl || kind !== "video") return undefined;
    const nextEp = curEp + 1;
    if (episodes.length > 0 && !episodes.some((e) => e.ep_num === nextEp)) return undefined;
    const nextKey = `${curId}:${nextEp}`;
    if (playUrls[nextKey] || preloadedKeysRef.current.has(nextKey)) return undefined;

    const timer = window.setTimeout(() => {
      preloadedKeysRef.current.add(nextKey);
      api.play(curId, nextEp)
        .then((info) => {
          if (!info?.video_url) return;
          setPlayUrls((m) => ({ ...m, [nextKey]: info.video_url }));
          const proxied = mediaUrl(info.video_url);
          if (proxied.includes("/hls?u=")) {
            fetch(proxied).catch(() => {});
          }
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [curId, curEp, playUrl, kind, episodes, playUrls]);

  /* 防手机自动息屏（Screen Wake Lock API） */
  useEffect(() => {
    const keepAwake = active && !paused && !vipLocked && hasVideo;
    if (!keepAwake) return undefined;
    let sentinel: { release?: () => Promise<void> } | null = null;
    let disposed = false;

    const requestLock = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: "screen") => Promise<{ release?: () => Promise<void> }> } }).wakeLock;
        if (wl && !disposed && document.visibilityState === "visible") {
          sentinel = await wl.request("screen");
        }
      } catch {
        /* 部分浏览器或省电模式忽略 */
      }
    };

    requestLock();
    const onVis = () => {
      if (document.visibilityState === "visible" && !disposed) requestLock();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVis);
      sentinel?.release?.().catch(() => {});
    };
  }, [active, paused, vipLocked, hasVideo]);

  /* 切换条目/集数时重置播放状态 */
  useEffect(() => {
    setTime(0); setDuration(0); setBuffered(0); setErr(""); setWaiting(true); setPaused(false); setDescOpen(false);
    setVsize({ w: 0, h: 0 });
    vipLockedRef.current = false;
    setVipLocked(false);
  }, [playKey]);

  /* 激活 VIP 后：如果当前正停在 15s 拦截处，立刻解锁并无缝继续播放 */
  useEffect(() => {
    if (isVip && vipLockedRef.current) {
      vipLockedRef.current = false;
      setVipLocked(false);
      if (active) videoRef.current?.play();
    } else if (!isVip && time >= PREVIEW_LIMIT && hasVideo) {
      videoRef.current?.pause();
      vipLockedRef.current = true;
      setVipLocked(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVip]);

  const triggerVipGate = useCallback(() => {
    videoRef.current?.pause();
    videoRef.current?.seek(PREVIEW_LIMIT);
    setTime(PREVIEW_LIMIT);
    if (!vipLockedRef.current) {
      vipLockedRef.current = true;
      setVipLocked(true);
      setVipModalOpen(true);
    }
  }, [setVipModalOpen]);

  const handleDuration = useCallback((d: number) => {
    setDuration(d);
    if (!curId || resumedKeysRef.current.has(playKey)) return;
    resumedKeysRef.current.add(playKey);

    const saved = progress[curId];
    if (!saved || saved.ep !== curEp) return;

    let target = saved.time;
    if (d > 0 && target >= d - 3) target = 0;
    if (!isVip && target >= PREVIEW_LIMIT - 1) target = Math.max(0, PREVIEW_LIMIT - 3);

    if (target > 2) {
      videoRef.current?.seek(target);
      setTime(target);
    }
    if (active && !notifiedVidsRef.current.has(curId) && (saved.ep > 1 || target > 5)) {
      notifiedVidsRef.current.add(curId);
      toast(
        target > 5 ? `已为你续播至 第 ${curEp} 集 ${fmtTime(target)}` : `已为你续播至 第 ${curEp} 集`,
        "info",
      );
    }
  }, [curId, playKey, progress, curEp, isVip, active, toast]);

  const handleTime = useCallback((t: number) => {
    if (!isVip && t >= PREVIEW_LIMIT) {
      triggerVipGate();
      return;
    }
    if (vipLockedRef.current && t < PREVIEW_LIMIT - 0.3) {
      vipLockedRef.current = false;
      setVipLocked(false);
    }
    setTime(t);
    if (curId && kind === "video") {
      saveProgress(curId, curEp, t, episodes.length || undefined);
    }
  }, [isVip, triggerVipGate, curId, kind, saveProgress, curEp, episodes.length]);

  const seekSafe = useCallback((target: number) => {
    if (!isVip && target >= PREVIEW_LIMIT) {
      triggerVipGate();
      setVipModalOpen(true);
      return false;
    }
    vipLockedRef.current = false;
    setVipLocked(false);
    videoRef.current?.seek(target);
    setTime(target);
    if (curId && kind === "video") {
      saveProgress(curId, curEp, target, episodes.length || undefined, true);
    }
    return true;
  }, [isVip, triggerVipGate, setVipModalOpen, curId, kind, saveProgress, curEp, episodes.length]);

  const togglePlaySafe = useCallback(() => {
    if (!isVip && (vipLockedRef.current || time >= PREVIEW_LIMIT - 0.15)) {
      triggerVipGate();
      setVipModalOpen(true);
      return;
    }
    videoRef.current?.toggle();
  }, [isVip, time, triggerVipGate, setVipModalOpen]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 非激活时暂停 */
  useEffect(() => { if (!active) videoRef.current?.pause(); }, [active]);

  /* 键盘 */
  useEffect(() => {
    if (!active) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); go(1); break;
        case "ArrowUp": e.preventDefault(); go(-1); break;
        case " ": e.preventDefault(); togglePlaySafe(); break;
        case "ArrowLeft": e.preventDefault(); seekSafe(Math.max(0, time - 5)); break;
        case "ArrowRight": e.preventDefault(); seekSafe(time + 5); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, panel, time, index, togglePlaySafe, seekSafe]);

  /* 安卓返回键：清屏模式先退出清屏，面板打开时先关面板 */
  useEffect(() => {
    if (cleanScreen) {
      setBackHandler(() => { setCleanScreen(false); return true; });
      return () => setBackHandler(null);
    }
    if (!panel) { setBackHandler(null); return undefined; }
    setBackHandler(() => { setPanel(null); return true; });
    return () => setBackHandler(null);
  }, [panel, cleanScreen]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    const el = e.currentTarget;
    const width = el.clientWidth || 1;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startY: e.clientY, t: Date.now(), base: time, width,
      mode: "idle" as "idle" | "hold" | "scrub",
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle") return;
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || isDesktop) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const armed = g.startY - e.clientY > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy)) {
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
        videoRef.current?.pause();
      } else if (Math.abs(dy) > 14) {
        if (g.timer) window.clearTimeout(g.timer);
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      setScrub(null);
      scrubTarget.current = null;
      if (target != null) {
        const ok = seekSafe(target);
        if (ok && !paused) videoRef.current?.play();
      }
      return;
    }

    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    // 右滑一键清屏 / 退出清屏
    if (dx > 45 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - g.t < 350) {
      setCleanScreen((v) => !v);
      try { navigator.vibrate?.(15); } catch { /* ignore */ }
      return;
    }

    // 双击检测：炸裂爱心粒子 + 点赞
    const now = Date.now();
    const last = lastTapRef.current;
    if (now - last.t < 280 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      lastTapRef.current = { t: 0, x: 0, y: 0 };
      if (curId && !isLiked(curId)) onLike();
      try { navigator.vibrate?.(25); } catch { /* ignore */ }
      const newHeart = {
        id: now,
        x: e.clientX,
        y: e.clientY,
        rot: (Math.random() - 0.5) * 36,
      };
      setBurstHearts((prev) => [...prev.slice(-3), newHeart]);
      setTimeout(() => {
        setBurstHearts((prev) => prev.filter((h) => h.id !== newHeart.id));
      }, 750);
      return;
    }
    lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };

    if (now - g.t < 260) {
      if (cleanScreen) {
        setCleanScreen(false);
      } else {
        togglePlaySafe();
      }
    }
  };

  /* 长按倍速期间禁止原生滚动，否则上滑会被列表吃掉、锁不住倍速 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => { if (holdRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length]);

  /* —— 进度条拖动（旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (clientX: number, clientY: number) => {
    const r = barRef.current?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (clientX: number, clientY: number) => {
    const pct = barPctAt(clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    barScrub.current = true;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    barSeekTo(e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.clientX, e.clientY);
    if (pct != null && duration) {
      const target = pct * duration;
      const ok = seekSafe(target);
      if (ok && !paused) videoRef.current?.play();
    }
    setBarPct(null);
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const requireLogin = () => { if (!user) { setLoginOpen(true); return false; } return true; };

  const onLike = () => {
    if (!curId) return;
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    toast(on ? "已加入喜欢" : "已取消喜欢", on ? "heart" : "info");
    if (requireLogin()) { if (kind === "post") api.postLike(curId, on).catch(() => {}); else api.like(curId, curEp, on).catch(() => {}); }
  };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    if (requireLogin()) { if (kind === "post") api.postCollect(curId, on).catch(() => {}); else api.collect(curId, on).catch(() => {}); }
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `已关注 ${detail?.author?.name}` : "已取消关注", on ? "ok" : "info");
    if (requireLogin()) api.follow(uid, on).catch(() => {});
  };

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    if (curId && kind === "video") {
      resumedKeysRef.current.add(`${curId}:${ep}`);
      saveProgress(curId, ep, 0, episodes.length || undefined, true);
    }
    setPanel(null);
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  return (
    <div
      className={`absolute inset-0 overflow-hidden bg-black player-root ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${rotated ? "fs-landscape" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      {/* 氛围背景 */}
      <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
        {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
      </div>

      <div ref={boxRef} onScroll={onScroll}
        className="absolute inset-y-0 left-0 overflow-y-scroll no-bar snap-y snap-mandatory"
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {videoIds.map((vid, i) => {
          const isActive = i === index;
          return (
            <section key={vid} className="relative w-full h-full snap-start overflow-hidden">
              {isActive && playUrl ? (
                <div className="absolute inset-0" style={{ touchAction: "pan-y" }}
                  onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
                <VideoSurface ref={videoRef} src={playUrl} poster={posterUrl} autoPlay muted={muted}
                  volume={volume} rate={effRate}
                  fit={customFit ? customFit : (isDesktop || (vsize.w > 0 && vsize.w > vsize.h) ? "contain" : "cover")}
                  onClick={() => { if (isDesktop) togglePlaySafe(); }}
                  onTime={handleTime}
                  onDuration={handleDuration}
                  onSize={(w, h) => setVsize({ w, h })}
                  onPlaying={() => { setPaused(false); setWaiting(false); }}
                  onPause={() => setPaused(true)}
                  onWaiting={() => setWaiting(true)}
                  onEnded={() => {
                    const next = episodes.find((e) => e.ep_num === curEp + 1);
                    if (next) {
                      pickEp(next.ep_num);
                      toast(`自动连播 · 第 ${next.ep_num} 集`, "info");
                    }
                  }}
                  onError={(m) => setErr(m)} />
                </div>
              ) : (
                <div className="absolute inset-0">
                  <Img src={detail?.cover || cards[vid]?.cover || posts[vid]?.cover || ""} eager={Math.abs(i - index) <= 1} />
                  <div className="absolute inset-0 bg-black/25" />
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full bg-white/92 text-[#0b0e15] text-[13.5px] font-semibold pressable elev-3">
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读 */}
              <div className="absolute inset-0 pointer-events-none"
                style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />

              {/* 顶部 */}
              {!fs && mode === "context" ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={onBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{title}</span>
                    <small>{index + 1} / {videoIds.length}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5 transition-opacity duration-200"
                    style={{ top: "calc(var(--sat, 0px) + 8px)", opacity: cleanScreen ? 0 : 1, pointerEvents: cleanScreen ? "none" : "auto" }}>
                    <button onClick={onBack} className="w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable elev-1"><IBack size={20} /></button>
                    <span className="text-[14.5px] font-semibold text-white tsh truncate">{title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full bg-black/45 text-[11px] font-semibold text-white/80">{index + 1} / {videoIds.length}</span>
                    <button onClick={store.lockDisguiseNow} aria-label="紧急伪装成计算器" className="w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-[#f7c355] pressable elev-1">
                      <IShield size={17} />
                    </button>
                    <button onClick={() => setMuted((m) => !m)} className="w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable elev-1">
                      {muted ? <IVolMute size={17} /> : <IVol size={17} />}
                    </button>
                  </div>
                )
              ) : null}

              {/* 右侧操作栏 */}
              {!fs && (
              <div className={`absolute z-20 flex flex-col items-center transition-opacity duration-200 ${isDesktop ? "desktop-social" : "right-3"}`}
                style={isDesktop ? undefined : { bottom: `calc(var(--sab, 0px) + ${bottomInset + 104}px)`, opacity: cleanScreen ? 0 : 1, pointerEvents: cleanScreen ? "none" : "auto" }}>
                {isDesktop && (
                  <div className="desktop-browse-inline">
                    <button onClick={() => go(-1)} disabled={index === 0} aria-label="上一个" title="上一个 ↑">
                      <IChevronUp size={19} strokeWidth={1.8} />
                    </button>
                    <button onClick={() => go(1)} disabled={index >= videoIds.length - 1} aria-label="下一个" title="下一个 ↓">
                      <IChevronDown size={19} strokeWidth={1.8} />
                    </button>
                    <small>{String(index + 1).padStart(2, "0")} / {String(videoIds.length).padStart(2, "0")}</small>
                  </div>
                )}
                {!isDesktop && (
                  <button onClick={onFollow} className="flex flex-col items-center gap-1 pressable">
                    <span className="relative">
                      <Avatar size={44} name={meta.author} hue={220} />
                      <span className={`absolute -bottom-0.5 -right-0.5 w-[18px] h-[18px] rounded-full flex items-center justify-center text-[10px] ${store.follows.includes(meta.authorId) ? "bg-s4 text-mut" : "bg-primary text-on-primary"}`}>
                        {store.follows.includes(meta.authorId) ? "✓" : <IPlus size={10} />}
                      </span>
                    </span>
                    <span className="text-[10px] text-white/80 mt-1 max-w-[52px] truncate">{meta.author}</span>
                  </button>
                )}

                {kind === "video" && (
                  <>
                    <button onClick={onLike} className="flex flex-col items-center gap-1 pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={heartBurst ? "a-pop" : ""}>
                        {isLiked(curId) ? <IHeartF size={30} className="text-neon" /> : <IHeart size={30} className="text-white tsh" />}
                      </span>
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="flex flex-col items-center gap-1 pressable">
                      <ICommentF size={27} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="flex flex-col items-center gap-1 pressable" aria-pressed={isFav(curId)}>
                      {isFav(curId) ? <IStarF size={27} className="text-amber" /> : <IStar size={27} className="text-white tsh" />}
                      <span className="text-[10.5px] text-white/90 tabular-nums">{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="flex flex-col items-center gap-1 pressable">
                      <IList size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">选集</span>
                    </button>

                    <button onClick={() => setCleanScreen(true)} className="flex flex-col items-center gap-1 pressable" title="清屏纯享">
                      <IScreenClean size={26} className="text-white tsh" />
                      <span className="text-[10.5px] text-white/90">清屏</span>
                    </button>

                    <button
                      onClick={() => {
                        const next = customFit === "contain" ? "cover" : "contain";
                        setCustomFit(next);
                        toast(next === "contain" ? "已切至完整比例（字幕完整）" : "已切至全屏撑满", "info");
                      }}
                      className="flex flex-col items-center gap-1 pressable"
                      title="画面比例">
                      <IAspect size={25} className={`tsh ${customFit === "contain" ? "text-amber" : "text-white"}`} />
                      <span className="text-[10.5px] text-white/90">{customFit === "contain" ? "比例" : "撑满"}</span>
                    </button>
                  </>
                )}

                <button onClick={() => {
                  const shareText = `【黄果短剧】${meta.title || "精彩短剧"}\n快来黄果 App 畅看全集！`;
                  navigator.clipboard?.writeText(shareText).then(() => toast("分享文案已复制", "ok")).catch(() => {});
                }} className="flex flex-col items-center gap-1 pressable">
                  <ILink size={25} className="text-white tsh" />
                  <span className="text-[10.5px] text-white/90">分享</span>
                </button>
              </div>
              )}

              {/* 左下信息：整体下移紧贴进度条，去掉标签/评分行避免挤占画面 */}
              {!fs && (
              <div className={isDesktop ? "desktop-video-meta" : "absolute left-3.5 right-[76px] z-20 transition-opacity duration-200"}
                style={isDesktop ? undefined : { bottom: `calc(var(--sab, 0px) + ${bottomInset + 22}px)`, opacity: cleanScreen ? 0 : 1, pointerEvents: cleanScreen ? "none" : "auto" }}>
                {/* VIP 试看状态胶囊 / 会员标识 */}
                {hasVideo && (
                  <div className="mb-2">
                    <button
                      type="button"
                      onClick={() => setVipModalOpen(true)}
                      className={`inline-flex items-center gap-1.5 h-7 px-3 rounded-full text-[11px] font-bold pressable backdrop-blur-md transition-all ${
                        isVip
                          ? "bg-black/55 border border-amber/35 text-[#ffd27d]"
                          : "bg-black/65 border border-amber/45 text-[#ffd88a] shadow-[0_4px_16px_rgba(245,166,35,0.22)]"
                      }`}>
                      <ISparkF size={12} className="text-amber" />
                      {isVip ? (
                        <span>尊享 VIP · 已解锁全集</span>
                      ) : vipLocked ? (
                        <span>试看已满 15 秒 · 点此输入卡密解锁</span>
                      ) : (
                        <span>免费试看 {Math.max(0, Math.ceil(PREVIEW_LIMIT - time))}s · 开通 VIP 看全集</span>
                      )}
                    </button>
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <span className="text-[15px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {episodes.length > 0 && (
                    <span className="shrink-0 px-1.5 py-px rounded-md bg-white/15 text-[10px] font-bold text-white">
                      第 {curEp}/{episodes.length} 集
                    </span>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold text-amber tsh">{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="mt-1 text-[13.5px] leading-snug text-white/95 tsh clamp-2">{meta.title}</p>

                {/* 描述（单行，点开展开） */}
                <button onClick={() => setDescOpen((v) => !v)} className="mt-1 text-left w-full pressable group">
                  <p className={`text-[11.5px] leading-relaxed text-white/62 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[10.5px] text-primary/90 font-semibold">{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}


              {/* 横拖定位浮层 */}
              {!isDesktop && scrub && (
                <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none bg-black/25">
                  <span className="text-[26px] font-bold text-white tabular-nums tsh">{fmtTime(scrub.target)}</span>
                  <span className="text-[11px] text-white/60 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                  <div className="mt-4 w-[62%] h-[3px] rounded-full bg-white/25 overflow-hidden">
                    <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                  </div>
                </div>
              )}

              {/* 15 秒免费试看结束拦截层 */}
              {isActive && !isVip && vipLocked && !err && (
                <div className="absolute inset-0 z-30 bg-black/75 backdrop-blur-md flex items-center justify-center px-6">
                  <div className="w-full max-w-[330px] rounded-(--r-lg) glass-card p-5 text-center border border-amber/30 a-pop relative overflow-hidden">
                    <div
                      className="absolute inset-x-0 top-0 h-24 pointer-events-none"
                      style={{
                        background: "radial-gradient(80% 100% at 50% 0%, rgba(255, 196, 82, 0.25) 0%, transparent 100%)",
                      }}
                    />
                    <div className="relative mx-auto w-12 h-12 rounded-2xl gold-grad flex items-center justify-center shadow-[0_8px_24px_-4px_rgba(245,166,35,0.55)]">
                      <ILockF size={22} />
                    </div>
                    <div className="relative mt-3 text-[16.5px] font-extrabold text-white">15 秒免费试看已结束</div>
                    <p className="relative mt-1 text-[12px] text-white/65 leading-relaxed">
                      开通 VIP 会员即可解锁本剧完整时长与全部剧集，输入数字卡密立即继续观看
                    </p>
                    <button
                      type="button"
                      onClick={() => setVipModalOpen(true)}
                      className="relative mt-4 w-full h-10.5 rounded-(--r-ctl) gold-grad text-[13.5px] font-extrabold pressable flex items-center justify-center gap-1.5 shadow-[0_6px_20px_-4px_rgba(245,166,35,0.5)]">
                      <ISparkF size={14} />
                      输入卡密 · 立即解锁全集
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        vipLockedRef.current = false;
                        setVipLocked(false);
                        setTime(0);
                        videoRef.current?.seek(0);
                        videoRef.current?.play();
                      }}
                      className="relative mt-2.5 w-full h-9 rounded-(--r-ctl) bg-white/8 border border-white/10 text-[12px] font-semibold text-white/80 pressable flex items-center justify-center gap-1.5">
                      <IReplay size={13} />
                      重新试看前 15 秒
                    </button>
                  </div>
                </div>
              )}

              {/* 暂停 / 缓冲 */}
              {isActive && paused && !vipLocked && !err && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                  <span className="w-[66px] h-[66px] rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center">
                    <IPlayF size={28} className="text-white/90 ml-0.5" />
                  </span>
                </div>
              )}
              {isActive && waiting && !err && !paused && !vipLocked && (
                <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
              )}
              {isActive && err && (
                <div className="absolute inset-0 z-20 flex items-center justify-center">
                  <div className="bg-black/70 rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] text-white/90">
                    <span>视频暂时无法加载</span>
                    <span className="text-[10.5px] text-white/45 max-w-[240px] text-center break-all">{err}</span>
                    <button className="text-primary text-[12.5px]" onClick={retryCurrentVideo}>重新获取播放地址</button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          nextDisabled={!episodes.some((e) => e.ep_num === curEp + 1) && index >= videoIds.length - 1}
          nextTitle={episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 E" : "下一部 ↓"}
          onToggle={togglePlaySafe}
          onSeek={(t) => { const ok = seekSafe(t); if (ok && !paused) videoRef.current?.play(); }}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={() => {
            const nx = episodes.find((e) => e.ep_num === curEp + 1);
            if (nx) pickEp(nx.ep_num);
            else go(1);
          }}
        />
      )}

      {/* 移动端：倍速状态 / 锁定提示 */}
      {!isDesktop && (holdSpeed || speedLock || rate !== 1) && (
        <button
          onClick={() => {
            if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); }
            else if (rate !== 1 && !holdSpeed) setRate(1);
          }}
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "bg-black/45 text-amber"}`}
          style={{ top: "calc(var(--sat, 0px) + 54px)" }}>
          <IBoltF size={13} />
          {effRate}x {speedLock ? "已锁定 · 点按解除" : holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
        </button>
      )}
      {!isDesktop && holdSpeed && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 transition-all duration-200 ${lockArmed ? "bg-primary text-on-primary scale-110" : "bg-black/50 text-white/85"}`}
          style={{ top: "38%" }}>
          <ILockF size={16} />
          <span className="text-[12.5px] font-bold">{lockArmed ? "松开锁定 2.0x" : "上滑到此锁定倍速"}</span>
        </div>
      )}

      {/* 移动端进度条：22px 热区，可拖动，上移并与悬浮胶囊底栏留出安全防误触间距 */}
      {!isDesktop && (
        <div ref={barRef} className="absolute inset-x-3.5 z-30"
          style={{ bottom: fs ? "calc(var(--sab, 0px) + 52px)" : `calc(var(--sab, 0px) + ${bottomInset}px)`, height: 22, touchAction: "none" }}
          onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
          <div className={`absolute inset-x-0 bottom-[6px] rounded-full transition-all duration-150 ${barPct !== null || fs ? "h-[5px] bg-white/28" : "h-[3px] bg-white/22"}`}>
            <div className="h-full relative rounded-full"
              style={{ width: `${barProgress * 100}%`, background: barPct !== null ? "linear-gradient(90deg, #ff6636, #ff2957)" : "rgba(255,255,255,.92)", transition: barPct !== null ? "none" : "width .25s linear" }}>
              <span className={`absolute right-[-5px] top-1/2 -translate-y-1/2 rounded-full bg-white elev-1 transition-transform duration-150 ${barPct !== null ? "w-3.5 h-3.5 scale-110" : "w-2.5 h-2.5"}`}
                style={{ boxShadow: "0 0 10px var(--p-glow)" }} />
            </div>
          </div>
          {barPct !== null && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-7 px-3.5 py-1.5 rounded-full glass-pill text-[15px] font-bold text-white tabular-nums">
              {fmtTime(barPct * (duration || 0))} <span className="text-white/50 text-[12px] font-medium">/ {fmtTime(duration)}</span>
            </div>
          )}
        </div>
      )}

      {/* 移动端：常驻极简时间进度（进度条右上方） */}
      {!isDesktop && !fs && duration > 0 && !cleanScreen && (
        <div
          className="absolute right-3.5 z-20 pointer-events-none flex items-center gap-1 text-[11px] font-bold text-white/85 tabular-nums tsh"
          style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 20}px)` }}>
          <span className="text-white/95">{fmtTime(time)}</span>
          <span className="text-white/40">/</span>
          <span className="text-white/60">{fmtTime(duration)}</span>
        </div>
      )}

      {/* 移动端：清屏纯享模式下的恢复按钮 */}
      {!isDesktop && !fs && cleanScreen && (
        <button
          onClick={() => setCleanScreen(false)}
          className="absolute right-3.5 z-40 px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/15 text-[11px] font-bold text-white pressable flex items-center gap-1.5 shadow-lg a-pop"
          style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 20}px)` }}>
          <IScreenClean size={13} />
          <span>退出清屏</span>
        </button>
      )}

      {/* 屏幕双击炸裂爱心粒子层 */}
      {burstHearts.map((h) => (
        <div
          key={h.id}
          className="pointer-events-none fixed z-50 a-heart-pop"
          style={{ left: h.x, top: h.y, ["--rot" as string]: `${h.rot}deg` }}>
          <IHeartF size={68} className="text-[#ff2957] drop-shadow-[0_4px_18px_rgba(255,41,87,0.75)]" />
        </div>
      ))}

      {/* 移动端：全屏入口 */}
      {!isDesktop && !fs && (
        <button onClick={() => setFs(true)} aria-label="全屏"
          className="absolute right-3.5 z-20 w-9 h-9 rounded-full bg-black/45 backdrop-blur-md border border-white/10 flex items-center justify-center text-white/90 pressable elev-1 transition-opacity duration-200"
          style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 56}px)`, opacity: cleanScreen ? 0 : 1, pointerEvents: cleanScreen ? "none" : "auto" }}>
          <IExpand size={17} />
        </button>
      )}

      {/* 移动端：沉浸全屏（安卓 WebView 不支持 Fullscreen API，改用应用内沉浸层） */}
      {!isDesktop && fs && (
        <>
          <button onClick={() => setFs(false)} aria-label="退出全屏"
            className="absolute right-3 z-40 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md flex items-center justify-center text-white pressable elev-1"
            style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
            <ICompress size={18} />
          </button>
          <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
            style={{ bottom: "calc(var(--sab, 0px) + 10px)" }}>
            <button onClick={() => videoRef.current?.toggle()}
              className="shrink-0 w-9 h-9 rounded-full bg-black/45 flex items-center justify-center text-white pressable">
              {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
            </button>
            <span className="shrink-0 text-[11.5px] font-semibold text-white/85 tabular-nums">{fmtTime(time)}</span>
            <button
              onClick={() => {
                if (speedLock) { setSpeedLock(false); return; }
                const seq = [1, 1.25, 1.5, 2];
                const i = seq.indexOf(rate);
                setRate(seq[(i + 1) % seq.length]);
              }}
              className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "bg-black/45 text-white/85"}`}>
              <IBoltF size={12} />{effRate}x
            </button>
            <span className="shrink-0 text-[11.5px] text-white/50 tabular-nums">{fmtTime(duration)}</span>
          </div>
        </>
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <Sheet open={panel !== null} onClose={() => setPanel(null)}>
          <div className="flex flex-col h-full" style={{ height: "72vh" }}>
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}
