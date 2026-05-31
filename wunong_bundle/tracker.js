/**
 * 屋弄家居 — 用户专注度追踪系统（前端）
 *
 * 追踪数据:
 *   - 页面停留时长（区分活跃/空闲）
 *   - 滚动深度 (25%/50%/75%/90%/100%)
 *   - 标签页可见性切换
 *   - 空闲检测（无操作 30s 视为空闲）
 *   - 15s 心跳上报
 *   - 页面关闭时上报总结
 *
 * 使用: 在 HTML 中引入即可自动运行
 *   <script src="tracker.js"></script>
 *
 * 自定义 API 端点:
 *   <script>window.FOCUS_API_ENDPOINT = 'http://localhost:3456/api/track';</script>
 *   <script src="tracker.js"></script>
 */

(function () {
  'use strict';

  /* ============================================================
   *  配置
   * ============================================================ */
  var ENDPOINT = window.FOCUS_API_ENDPOINT || '/api/track';
  var HEARTBEAT_MS = 15000;       // 每 15s 一次心跳
  var IDLE_THRESHOLD_MS = 30000;   // 无操作 30s 视为空闲
  var SCROLL_DEPTHS = [25, 50, 75, 90, 100];
  var BATCH_SIZE = 10;             // 攒够 10 条事件自动发送

  /* ============================================================
   *  ID 生成
   * ============================================================ */
  function genId() {
    return 'xxxxxxxxxxxx4xxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  var userId = localStorage.getItem('wunong_uid');
  if (!userId) {
    userId = genId();
    localStorage.setItem('wunong_uid', userId);
  }

  var sessionId = genId();

  /* ============================================================
   *  状态
   * ============================================================ */
  var state = {
    sessionId: sessionId,
    userId: userId,
    pageUrl: location.href,
    referrer: document.referrer || '',
    screenSize: screen.width + 'x' + screen.height,
    viewportSize: innerWidth + 'x' + innerHeight,
    entryTime: Date.now(),
    lastActiveTime: Date.now(),
    tabVisible: !document.hidden,
    tabSwitches: 0,
    maxScrollDepth: 0,
    totalIdleMs: 0,
    isIdle: false,
    idleStartTime: null,
    scrolledDepths: {},
    heartbeats: 0,
    queue: [],
  };

  /* ============================================================
   *  发送数据
   * ============================================================ */
  function send(body) {
    try {
      var payload = JSON.stringify(body);
      if (navigator.sendBeacon) {
        navigator.sendBeacon(ENDPOINT, payload);
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', ENDPOINT, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(payload);
      }
    } catch (e) { /* 静默失败 */ }
  }

  /* ============================================================
   *  事件队列
   * ============================================================ */
  function pushEvent(type, extra) {
    var ev = {
      session_id: sessionId,
      user_id: userId,
      event_type: type,
      page_url: state.pageUrl,
      tab_visible: state.tabVisible ? 1 : 0,
      time_on_page_sec: Math.round((Date.now() - state.entryTime) / 1000),
    };

    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) ev[k] = extra[k];
      }
    }

    state.queue.push(ev);

    if (state.queue.length >= BATCH_SIZE) {
      flush();
    }
  }

  function flush() {
    if (state.queue.length === 0) return;
    var batch = state.queue.splice(0);
    send({ type: 'batch', events: batch });
  }

  /* ============================================================
   *  滚动深度
   * ============================================================ */
  function onScroll() {
    cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = requestAnimationFrame(function () {
      var scrollTop = window.scrollY;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight <= 0) return;

      var pct = Math.min(100, Math.round((scrollTop / docHeight) * 100));
      if (pct > state.maxScrollDepth) state.maxScrollDepth = pct;

      for (var i = 0; i < SCROLL_DEPTHS.length; i++) {
        var d = SCROLL_DEPTHS[i];
        if (pct >= d && !state.scrolledDepths[d]) {
          state.scrolledDepths[d] = true;
          pushEvent('scroll_depth', { scroll_depth_pct: d });
        }
      }
    });
    markActive();
  }

  /* ============================================================
   *  标签页可见性
   * ============================================================ */
  function onVisibilityChange() {
    var visible = !document.hidden;
    if (visible === state.tabVisible) return;

    state.tabVisible = visible;

    if (!visible) {
      state.tabSwitches++;
    }

    pushEvent('tab_visibility', { tab_visible: visible ? 1 : 0 });

    if (visible) markActive();
  }

  /* ============================================================
   *  空闲检测
   * ============================================================ */
  function markActive() {
    var now = Date.now();
    if (state.isIdle) {
      state.isIdle = false;
      state.totalIdleMs += now - state.idleStartTime;
      pushEvent('idle_end', { idle_duration_ms: now - state.idleStartTime });
    }
    state.lastActiveTime = now;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(goIdle, IDLE_THRESHOLD_MS);
  }

  function goIdle() {
    state.isIdle = true;
    state.idleStartTime = Date.now();
    pushEvent('idle_start', {});
  }

  /* ============================================================
   *  心跳
   * ============================================================ */
  function heartbeat() {
    state.heartbeats++;
    var now = Date.now();
    var elapsed = now - state.entryTime;

    pushEvent('heartbeat', {
      duration_sec: Math.round(elapsed / 1000),
      active_sec: Math.round((elapsed - state.totalIdleMs) / 1000),
      scroll_depth_pct: state.maxScrollDepth,
      tab_switches: state.tabSwitches,
      heartbeats: state.heartbeats,
    });
  }

  /* ============================================================
   *  会话结束
   * ============================================================ */
  function onSessionEnd() {
    var now = Date.now();
    var elapsed = now - state.entryTime;

    pushEvent('session_end', {
      duration_sec: Math.round(elapsed / 1000),
      active_sec: Math.round((elapsed - state.totalIdleMs) / 1000),
      max_scroll_depth_pct: state.maxScrollDepth,
      tab_switches: state.tabSwitches,
      heartbeats: state.heartbeats,
    });

    flush();
  }

  /* ============================================================
   *  Section 浏览追踪（复用已有的 IntersectionObserver）
   * ============================================================ */
  function setupSectionTracking() {
    var sections = document.querySelectorAll('section[id]');
    if (!sections.length) return;

    var seen = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          var id = e.target.id;
          if (!seen[id]) {
            seen[id] = true;
            pushEvent('section_view', {
              section_id: id,
            });
          }
        }
      });
    }, { threshold: 0.3 });

    sections.forEach(function (el) { observer.observe(el); });
  }

  /* ============================================================
   *  初始化
   * ============================================================ */
  function init() {
    // 页面浏览事件
    pushEvent('page_view', {
      title: document.title,
      referrer: state.referrer,
      screen: state.screenSize,
      viewport: state.viewportSize,
    });

    // 滚动
    window.addEventListener('scroll', onScroll, { passive: true });

    // 标签页可见性
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 活跃操作监听
    var activityEvents = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'wheel', 'click'];
    for (var i = 0; i < activityEvents.length; i++) {
      window.addEventListener(activityEvents[i], markActive, { passive: true });
    }

    // 节流 flush（每 30s 确保数据发出）
    setInterval(flush, 30000);

    // 心跳
    setInterval(heartbeat, HEARTBEAT_MS);

    // 空闲定时器
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(goIdle, IDLE_THRESHOLD_MS);

    // Section 追踪
    setupSectionTracking();

    // 页面关闭/离开
    window.addEventListener('beforeunload', onSessionEnd);

    // 暴露到全局，便于调试
    window.__focusTracker = {
      sessionId: sessionId,
      userId: userId,
      state: state,
      pushEvent: pushEvent,
      flush: flush,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
