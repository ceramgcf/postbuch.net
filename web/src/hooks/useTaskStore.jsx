import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

const TaskContext = createContext(null);

const STORAGE_KEY = 'postbuch-tasks';
const COMPLETED_TTL = 5 * 60 * 1000; // 5 minutes

function loadTasks() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveTasks(tasks) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function taskReducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return [...state, action.payload];
    case 'SET_JOB_ID':
      return state.map(t => t.id === action.id ? { ...t, jobId: action.jobId } : t);
    case 'COMPLETE':
      return state.map(t => t.id === action.id && !t.completedAt
        ? { ...t, completedAt: Date.now(), result: action.result ?? 'success' }
        : t);
    case 'FAIL':
      return state.map(t => t.id === action.id && !t.completedAt
        ? { ...t, completedAt: Date.now(), result: 'error', errorMessage: action.errorMessage }
        : t);
    case 'REMOVE':
      return state.filter(t => t.id !== action.id);
    default:
      return state;
  }
}

export function TaskProvider({ children }) {
  const [tasks, dispatch] = useReducer(taskReducer, null, loadTasks);
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  useEffect(() => { saveTasks(tasks); }, [tasks]);

  // Cleanup completed tasks older than 5 min
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      tasksRef.current.forEach(t => {
        if (t.completedAt && now - t.completedAt > COMPLETED_TTL) {
          dispatch({ type: 'REMOVE', id: t.id });
        }
      });
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Reconcile reprocess tasks against the server. Catches the case where a
  // reload (or tab close) killed the in-component polling and left the task
  // hanging as "active" forever in sessionStorage.
  useEffect(() => {
    const RECONCILE_INTERVAL = 5000;
    // Tasks älter als 11 min ohne jobId gelten als verloren (Pipeline-Timeout: 10 min).
    const ORPHAN_MAX_AGE = 11 * 60 * 1000;

    const reconcile = async () => {
      const active = tasksRef.current.filter(
        t => t.type === 'reprocess' && !t.completedAt,
      );
      for (const t of active) {
        if (!t.jobId) {
          if (Date.now() - t.startedAt > ORPHAN_MAX_AGE) {
            dispatch({
              type: 'FAIL',
              id: t.id,
              errorMessage: 'Verbindung verloren – Status unbekannt',
            });
          }
          continue;
        }
        try {
          const job = await api.jobs.get(t.jobId);
          if (job.status === 'done') {
            dispatch({ type: 'COMPLETE', id: t.id });
          } else if (job.status === 'failed') {
            dispatch({
              type: 'FAIL',
              id: t.id,
              errorMessage: job.error_message || 'Verarbeitung fehlgeschlagen',
            });
          } else if (job.status === 'cancelled') {
            dispatch({ type: 'FAIL', id: t.id, errorMessage: 'Verarbeitung wurde abgebrochen' });
          }
        } catch {
          // Job nicht mehr auffindbar (404) o. ä. → als Fail markieren, sonst hängt der Task ewig.
          if (Date.now() - t.startedAt > ORPHAN_MAX_AGE) {
            dispatch({
              type: 'FAIL',
              id: t.id,
              errorMessage: 'Job nicht mehr auffindbar',
            });
          }
        }
      }
    };

    reconcile();
    const id = setInterval(reconcile, RECONCILE_INTERVAL);
    return () => clearInterval(id);
  }, []);

  // Poll server for scheduled debounce embedding timers (postbuch + akten) and reflect as tasks.
  // Only compares against ACTIVE (non-completed) tasks to correctly handle re-edits.
  // Eingeschränkte Konten erreichen die Embedding-Warteschlange nicht (403).
  const { istEingeschraenkt } = useAuth();
  useEffect(() => {
    if (istEingeschraenkt) return undefined;
    const syncEmbeddingQueue = async () => {
      try {
        const [pbResp, akResp] = await Promise.all([
          api.postbuch.embeddingQueue().catch(() => ({ postids: [] })),
          api.akten.embeddingQueue().catch(() => ({ akteidList: [] })),
        ]);
        const pendingPostids = pbResp?.postids || [];
        const pendingAkteids = akResp?.akteidList || [];

        // Only look at ACTIVE embedding tasks – completed ones must not block re-adding
        const activeTasks = tasksRef.current.filter(
          t => (t.type === 'embedding-debounce') && !t.completedAt
        );
        // Key: "pb:<postid>" or "ak:<akteid>"
        const activeByKey = new Map(activeTasks.map(t => [t.embeddingKey, t]));
        const now = Date.now();

        for (const postid of pendingPostids) {
          if (!activeByKey.has(`pb:${postid}`)) {
            dispatch({
              type: 'ADD',
              payload: {
                id: `embed-pb-${postid}-${now}`,
                type: 'embedding-debounce',
                embeddingKey: `pb:${postid}`,
                postid,
                label: `Embedding wartet: ${postid}`,
                startedAt: now,
                completedAt: null,
                result: null,
              },
            });
          }
        }

        for (const akteid of pendingAkteids) {
          if (!activeByKey.has(`ak:${akteid}`)) {
            dispatch({
              type: 'ADD',
              payload: {
                id: `embed-ak-${akteid}-${now}`,
                type: 'embedding-debounce',
                embeddingKey: `ak:${akteid}`,
                postid: akteid,
                label: `Embedding wartet: ${akteid}`,
                startedAt: now,
                completedAt: null,
                result: null,
              },
            });
          }
        }

        // Mark tasks as done that no longer appear on server
        for (const t of activeTasks) {
          const stillPending =
            (t.embeddingKey?.startsWith('pb:') && pendingPostids.includes(t.postid)) ||
            (t.embeddingKey?.startsWith('ak:') && pendingAkteids.includes(t.postid));
          if (!stillPending) {
            dispatch({ type: 'COMPLETE', id: t.id });
          }
        }
      } catch {
        // ignore transient polling errors
      }
    };

    syncEmbeddingQueue();
    const id = setInterval(syncEmbeddingQueue, 5000);
    return () => clearInterval(id);
  }, [dispatch, istEingeschraenkt]);

  const addTask = useCallback(({ type, postid, label }) => {
    const id = `${postid}-${Date.now()}`;
    dispatch({
      type: 'ADD',
      payload: { id, type, postid, label, jobId: null, startedAt: Date.now(), completedAt: null, result: null },
    });
    return id;
  }, []);

  const setTaskJobId = useCallback((id, jobId) => {
    dispatch({ type: 'SET_JOB_ID', id, jobId });
  }, []);

  const completeTask = useCallback((id) => {
    dispatch({ type: 'COMPLETE', id });
  }, []);

  const failTask = useCallback((id, errorMessage) => {
    dispatch({ type: 'FAIL', id, errorMessage });
  }, []);

  const value = {
    tasks,
    activeTasks: tasks.filter(t => !t.completedAt),
    recentTasks: tasks.filter(t => t.completedAt && Date.now() - t.completedAt < COMPLETED_TTL),
    addTask,
    setTaskJobId,
    completeTask,
    failTask,
  };

  return <TaskContext.Provider value={value}>{children}</TaskContext.Provider>;
}

export function useTaskStore() {
  const ctx = useContext(TaskContext);
  if (!ctx) throw new Error('useTaskStore must be used within TaskProvider');
  return ctx;
}
