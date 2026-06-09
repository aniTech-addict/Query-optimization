import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const vscode = acquireVsCodeApi();

// ─── Severity badge colors ───────────────────────────────────────────────────
const TYPE_COLORS = {
  scan:      '#3794ff',
  analysis:  '#c586c0',
  highlight: '#dcdcaa',
  config:    '#4ec9b0',
  upload:    '#6a9955',
  error:     '#f44747',
  info:      '#569cd6',
};

function Badge({ type }) {
  const bg = TYPE_COLORS[type] || '#888';
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: '3px',
      fontSize: '11px',
      fontWeight: 600,
      backgroundColor: bg,
      color: '#1e1e1e',
      marginRight: '8px',
      textTransform: 'uppercase',
      letterSpacing: '.5px',
    }}>
      {type}
    </span>
  );
}

function ActivityItem({ entry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  return (
    <div style={{
      padding: '8px 12px',
      borderBottom: '1px solid var(--vscode-panel-border, #333)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
    }}>
      <span style={{
        color: 'var(--vscode-descriptionForeground)',
        fontSize: '11px',
        minWidth: '70px',
        flexShrink: 0,
        marginTop: '2px',
      }}>{time}</span>
      <Badge type={entry.type} />
      <span style={{ color: 'var(--vscode-editor-foreground)', fontSize: '13px', flex: 1 }}>
        {entry.message}
      </span>
    </div>
  );
}

function App() {
  const [activities, setActivities] = useState([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('all');
  const lastId = useRef(0);
  const bottomRef = useRef(null);

  // Poll Express for new activity entries
  const pollActivities = useCallback(() => {
    vscode.postMessage({ command: 'getActivity', sinceId: lastId.current });
  }, []);

  useEffect(() => {
    // Listen for messages from the extension host
    const handler = (event) => {
      const msg = event.data;
      if (msg.command === 'activityUpdate' && Array.isArray(msg.entries)) {
        if (msg.entries.length > 0) {
          setActivities(prev => {
            const merged = [...prev, ...msg.entries];
            // Keep last 200
            return merged.slice(Math.max(0, merged.length - 200));
          });
          lastId.current = msg.entries[msg.entries.length - 1].id;
        }
      } else if (msg.command === 'configUpdated') {
        setStatus(`Config updated: ${JSON.stringify(msg.config.src)}`);
      }
    };
    window.addEventListener('message', handler);

    // Initial fetch + polling every 3s
    pollActivities();
    const timer = setInterval(pollActivities, 3000);

    return () => {
      window.removeEventListener('message', handler);
      clearInterval(timer);
    };
  }, [pollActivities]);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activities]);

  const filtered = filter === 'all'
    ? activities
    : activities.filter(a => a.type === filter);

  const types = ['all', ...Object.keys(TYPE_COLORS)];

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'var(--vscode-font-family)',
      backgroundColor: 'var(--vscode-editor-background)',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--vscode-panel-border, #333)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <h2 style={{
          margin: 0,
          fontSize: '14px',
          color: 'var(--vscode-editor-foreground)',
          fontWeight: 600,
        }}>
          Mongoose Optimizer — Activity Dashboard
        </h2>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={() => vscode.postMessage({ command: 'createJson' })}
            style={btnStyle}
          >
            Init Config
          </button>
          <button
            onClick={() => {
              setActivities([]);
              lastId.current = 0;
              vscode.postMessage({ command: 'clearActivity' });
            }}
            style={{ ...btnStyle, backgroundColor: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)' }}
          >
            Clear Log
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{
        padding: '6px 16px',
        display: 'flex',
        gap: '4px',
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--vscode-panel-border, #333)',
        flexShrink: 0,
      }}>
        {types.map(t => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            style={{
              padding: '2px 10px',
              borderRadius: '3px',
              border: filter === t ? '1px solid var(--vscode-focusBorder)' : '1px solid transparent',
              backgroundColor: filter === t ? 'var(--vscode-button-background)' : 'transparent',
              color: filter === t ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)',
              cursor: 'pointer',
              fontSize: '11px',
              textTransform: 'uppercase',
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Activity feed */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: '40px',
            textAlign: 'center',
            color: 'var(--vscode-descriptionForeground)',
          }}>
            No activity yet. The MCP server will log actions here.
          </div>
        ) : (
          filtered.map(entry => <ActivityItem key={entry.id} entry={entry} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Status bar */}
      {status && (
        <div style={{
          padding: '4px 16px',
          fontSize: '11px',
          color: 'var(--vscode-descriptionForeground)',
          borderTop: '1px solid var(--vscode-panel-border, #333)',
          flexShrink: 0,
        }}>
          {status}
        </div>
      )}
    </div>
  );
}

const btnStyle = {
  padding: '4px 12px',
  backgroundColor: 'var(--vscode-button-background)',
  color: 'var(--vscode-button-foreground)',
  border: 'none',
  borderRadius: '2px',
  cursor: 'pointer',
  fontSize: '12px',
};

const container = document.getElementById('root');
const root = createRoot(container);
root.render(<App />);
