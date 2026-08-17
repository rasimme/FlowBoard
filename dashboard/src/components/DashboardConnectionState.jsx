import { RefreshCw, ServerCrash, ShieldAlert, WifiOff } from 'lucide-react';
import { useDashboard } from '../context/DashboardContext.jsx';
import Button from './Button.jsx';
import Spinner from './Spinner.jsx';

const COPY = {
  'auth-error': {
    Icon: ShieldAlert,
    title: 'Sign-in required',
    fatal: 'FlowBoard could not verify this session. Open the dashboard from your Telegram bot again to refresh authentication. If it still fails, verify the bot token, allowed user ID, and tunnel URL.',
    degraded: 'Authentication expired. Your last loaded board is still visible; reopen FlowBoard from Telegram or retry.',
  },
  offline: {
    Icon: WifiOff,
    title: 'FlowBoard is offline',
    fatal: 'The dashboard service could not be reached. Check your connection and confirm that FlowBoard is running, then retry.',
    degraded: 'The dashboard service cannot be reached. Your last loaded board is still visible.',
  },
  timeout: {
    Icon: WifiOff,
    title: 'FlowBoard took too long to respond',
    fatal: 'The dashboard request reached its deadline. Retry now; if it keeps timing out, check the connection and dashboard service.',
    degraded: 'A refresh timed out. Your last loaded board is still visible and you can retry safely.',
  },
  'server-error': {
    Icon: ServerCrash,
    title: 'Dashboard service error',
    fatal: 'FlowBoard returned an unexpected server error. Retry in a moment; if it persists, check the dashboard service logs.',
    degraded: 'A refresh failed. Your last loaded board is still visible and has not been replaced with empty data.',
  },
};

function RetryButton({ retrying, onRetry }) {
  return (
    <Button
      data-action="retry-connection"
      onClick={onRetry}
      disabled={retrying}
      className="connection-retry min-h-11"
    >
      {retrying ? <Spinner size="sm" className="text-white" /> : <RefreshCw size={15} />}
      {retrying ? 'Retrying…' : 'Retry'}
    </Button>
  );
}

export default function DashboardConnectionState() {
  const { state, retryConnection } = useDashboard();
  const connection = state?.connection;
  const status = connection?.status || 'loading';
  const hasData = !!connection?.hasData;
  const failure = COPY[status];

  if (!failure && status !== 'loading') {
    return <span className="connection-state-marker" data-connection-state={status} aria-hidden="true" />;
  }

  if (!hasData) {
    const Icon = failure?.Icon;
    return (
      <div
        className={`connection-screen ${failure ? 'is-error' : 'is-loading'}`}
        data-connection-state={status}
        role={failure ? 'alert' : 'status'}
        aria-live="polite"
      >
        <section className="connection-card">
          <div className={`connection-icon ${failure ? 'is-error' : ''}`}>
            {Icon ? <Icon size={28} /> : <Spinner size={28} className="text-accent" />}
          </div>
          <p className="connection-kicker">FlowBoard</p>
          <h1>{failure?.title || 'Loading dashboard'}</h1>
          <p className="connection-message">
            {failure?.fatal || 'Connecting to the dashboard service and loading your projects…'}
          </p>
          {connection?.httpStatus && <code className="connection-code">HTTP {connection.httpStatus}</code>}
          {(failure || status === 'loading') && (
            <RetryButton retrying={connection.retrying} onRetry={retryConnection} />
          )}
        </section>
      </div>
    );
  }

  return (
    <div
      className="connection-banner"
      data-connection-state={status}
      role="alert"
      aria-live="assertive"
    >
      <failure.Icon size={18} className="connection-banner-icon" />
      <div className="connection-banner-copy">
        <strong>{failure.title}</strong>
        <span>{failure.degraded}</span>
      </div>
      {connection?.httpStatus && <code className="connection-code">HTTP {connection.httpStatus}</code>}
      <RetryButton retrying={connection.retrying} onRetry={retryConnection} />
    </div>
  );
}
