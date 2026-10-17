'use strict';

const express = require('express');

function isTelemetryPath(reqPath) {
  return reqPath === '/api/telemetry' || reqPath.startsWith('/api/telemetry/');
}

function isJevPath(reqPath) {
  return reqPath === '/api/jev' || reqPath.startsWith('/api/jev/');
}

/**
 * Apply the general 1 MB JSON limit everywhere except telemetry and Jev. Both
 * routers own stricter route-local parsers (telemetry 32 KB, Jev 48 KB) and
 * their own error handlers; parsing here first would consume the stream and
 * silently bypass those route-specific limits.
 */
function createGlobalJsonParser() {
  const parser = express.json({ limit: '1mb' });
  return (req, res, next) => (isTelemetryPath(req.path) || isJevPath(req.path) ? next() : parser(req, res, next));
}

module.exports = { createGlobalJsonParser, isTelemetryPath, isJevPath };
