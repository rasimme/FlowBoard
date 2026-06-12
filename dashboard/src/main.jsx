import './bootstrap.js'; // must run first: owns window.appState + __flowboardBootstrap
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import '../styles/canvas.css';

const container = document.getElementById('react-root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
