// Cloudflare Container Worker entry point
// This Worker manages the RSSHub container lifecycle and proxies requests

import { Container } from '@cloudflare/containers';
import type { KVNamespace } from '@cloudflare/workers-types';

const INSTANCE_COUNT = 60;
const FAILURE_REASON_LIMIT = 160;
const RSSHUB_ROUTE_HEADER = 'X-RSSHub-Route';
const UNKNOWN_ROUTE = 'unknown';

export class RSSHubContainer extends Container {
    defaultPort = 1200;
    sleepAfter = '10m';
    enableInternet = true;
}

interface Env {
    RSSHUB_CONTAINER: DurableObjectNamespace<RSSHubContainer>;
    CONFIG: KVNamespace;
    REQUEST_ANALYTICS?: AnalyticsEngineDataset;
}

interface RequestMetric {
    method: string;
    hostname: string;
    requestPath: string;
    requestRoute: string;
    containerName: string;
    durationMs: number;
    statusCode: number;
    outcome: 'success' | 'failure';
    failureType: 'none' | 'http_error' | 'exception';
    failureReason: string;
}

async function loadEnvVars(config: KVNamespace): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {
        NODE_ENV: 'production',
    };

    const keys = await config.list();
    await Promise.all(
        keys.keys.map(async ({ name }) => {
            const value = await config.get(name);
            if (value) {
                envVars[name] = value;
            }
        })
    );

    return envVars;
}

function getStatusFamily(statusCode: number): string {
    if (statusCode <= 0) {
        return 'exception';
    }

    return `${Math.floor(statusCode / 100)}xx`;
}

async function getFailureReasonFromResponse(response: Response, expectsJsonErrorBody: boolean): Promise<string> {
    const fallbackReason = limitString(
        `http_${response.status}_${slugify(response.statusText, 'unknown_status')}`,
        FAILURE_REASON_LIMIT
    );

    if (!expectsJsonErrorBody && !isJsonResponse(response)) {
        return fallbackReason;
    }

    try {
        const payload = await response.clone().json();
        const errorMessage = extractErrorMessageFromBody(payload);

        if (errorMessage) {
            return limitString(compactText(errorMessage, 'unknown_error'), FAILURE_REASON_LIMIT);
        }
    } catch {
        // Ignore body parsing failures and keep the HTTP-level fallback.
    }

    return fallbackReason;
}

function getFailureReasonFromError(error: unknown): string {
    if (error instanceof Error) {
        return limitString(
            `${slugify(error.name, 'error')}:${compactText(error.message, 'unknown_error')}`,
            FAILURE_REASON_LIMIT
        );
    }

    if (typeof error === 'string') {
        return limitString(compactText(error, 'unknown_error'), FAILURE_REASON_LIMIT);
    }

    return 'unknown_error';
}

function slugify(value: string, fallback: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return normalized || fallback;
}

function compactText(value: string, fallback: string): string {
    const compacted = value.trim().replace(/\s+/g, ' ');
    return compacted || fallback;
}

function isJsonResponse(response: Response): boolean {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    return contentType.includes('application/json') || contentType.includes('+json');
}

function extractErrorMessageFromBody(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== 'object') {
        return null;
    }

    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() ? message : null;
}

function limitString(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function getSamplingKey(method: string, requestRoute: string): string {
    return limitString(`${method}:${requestRoute}`, 96);
}

function writeRequestMetric(env: Env, metric: RequestMetric): void {
    if (!env.REQUEST_ANALYTICS) {
        return;
    }

    try {
        // Keep blob/double positions stable so SQL queries stay predictable.
        env.REQUEST_ANALYTICS.writeDataPoint({
            indexes: [getSamplingKey(metric.method, metric.requestRoute)],
            blobs: [
                metric.method,
                metric.hostname,
                metric.requestPath,
                metric.requestRoute,
                metric.containerName,
                getStatusFamily(metric.statusCode),
                metric.outcome,
                metric.failureType,
                metric.failureReason,
            ],
            doubles: [metric.durationMs, metric.statusCode],
        });
    } catch (error) {
        console.error('Failed to write Analytics Engine datapoint', error);
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const startedAt = performance.now();
        const url = new URL(request.url);
        const requestPath = url.pathname;
        const expectsJsonErrorBody = url.searchParams.get('format') === 'json';

        const instanceIndex = Math.floor(Math.random() * INSTANCE_COUNT);
        const containerName = `rsshub-${instanceIndex}`;

        let statusCode = 0;
        let requestRoute = UNKNOWN_ROUTE;
        let outcome: RequestMetric['outcome'] = 'failure';
        let failureType: RequestMetric['failureType'] = 'exception';
        let failureReason = 'unknown_error';

        try {
            const envVars = await loadEnvVars(env.CONFIG);
            const container = env.RSSHUB_CONTAINER.getByName(containerName);

            await container.startAndWaitForPorts({
                startOptions: { envVars },
            });

            const response = await container.fetch(request);
            statusCode = response.status;
            requestRoute = response.headers.get(RSSHUB_ROUTE_HEADER)?.trim() || UNKNOWN_ROUTE;

            if (response.ok) {
                outcome = 'success';
                failureType = 'none';
                failureReason = 'none';
            } else {
                failureType = 'http_error';
                failureReason = await getFailureReasonFromResponse(response, expectsJsonErrorBody);
            }

            return response;
        } catch (error) {
            failureReason = getFailureReasonFromError(error);
            console.error('Failed to proxy RSSHub request', {
                requestPath,
                requestRoute,
                containerName,
                error,
            });
            throw error;
        } finally {
            writeRequestMetric(env, {
                method: request.method,
                hostname: url.hostname,
                requestPath,
                requestRoute,
                containerName,
                durationMs: Number((performance.now() - startedAt).toFixed(3)),
                statusCode,
                outcome,
                failureType,
                failureReason,
            });
        }
    },
};
