#!/bin/sh

# AnyCrawl MCP Server with Nginx Docker Entrypoint
# Integrated nginx proxy functionality

set -e

# Default values
ANYCRAWL_MODE=${ANYCRAWL_MODE:-"MCP"}
ANYCRAWL_PORT=${ANYCRAWL_PORT:-3000}
ANYCRAWL_MCP_PORT=${ANYCRAWL_MCP_PORT:-3000}
ANYCRAWL_SSE_PORT=${ANYCRAWL_SSE_PORT:-3001}
ANYCRAWL_HOST=${ANYCRAWL_HOST:-"0.0.0.0"}
CLOUD_SERVICE=${CLOUD_SERVICE:-"false"}
ENABLE_NGINX=${ENABLE_NGINX:-"true"}

# Log configuration
echo "🚀 Starting AnyCrawl MCP Server with Nginx..."
echo "   Mode: $ANYCRAWL_MODE"
echo "   Port: $ANYCRAWL_PORT (MCP:$ANYCRAWL_MCP_PORT, SSE:$ANYCRAWL_SSE_PORT)"
echo "   Host: $ANYCRAWL_HOST"
echo "   Cloud Service: $CLOUD_SERVICE"
echo "   Nginx Enabled: $ENABLE_NGINX"

# Validate required environment variables
if [ "$CLOUD_SERVICE" = "true" ]; then
    echo "✅ Running in cloud service mode"
    echo "   API keys will be extracted from request headers"
else
    echo "✅ Running in self-hosted mode"
    if [ -n "$ANYCRAWL_API_KEY" ]; then
        echo "   Using API key from environment"
    fi
    if [ -n "$ANYCRAWL_BASE_URL" ]; then
        echo "   Using base URL: $ANYCRAWL_BASE_URL"
    else
        echo "   Using default base URL: https://api.anycrawl.dev"
    fi
fi

# Wait for any dependencies (if needed)
if [ -n "$WAIT_FOR_HOST" ] && [ -n "$WAIT_FOR_PORT" ]; then
    echo "⏳ Waiting for $WAIT_FOR_HOST:$WAIT_FOR_PORT to be available..."
    while ! nc -z "$WAIT_FOR_HOST" "$WAIT_FOR_PORT"; do
        sleep 1
    done
    echo "✅ $WAIT_FOR_HOST:$WAIT_FOR_PORT is available"
fi

# Health check function
health_check() {
    local port=$1
    local max_attempts=30
    local attempt=1
    
    echo "🔍 Performing health check on port $port..."
    
    while [ $attempt -le $max_attempts ]; do
        if curl -f -s "http://localhost:$port/health" > /dev/null 2>&1; then
            echo "✅ Health check passed on attempt $attempt"
            return 0
        fi
        
        echo "   Attempt $attempt/$max_attempts: Health check failed, retrying in 2 seconds..."
        sleep 2
        attempt=$((attempt + 1))
    done
    
    echo "❌ Health check failed after $max_attempts attempts"
    return 1
}

# Nginx functions
start_nginx() {
    if [ "$ENABLE_NGINX" = "true" ]; then
        echo "🌐 Starting Nginx proxy..."
        
        # Test nginx configuration
        nginx -t
        if [ $? -ne 0 ]; then
            echo "❌ Nginx configuration test failed"
            exit 1
        fi
        
        # Start nginx in background
        nginx -g "daemon off;" &
        NGINX_PID=$!
        
        # Wait for nginx to start
        sleep 2
        
        # Check if nginx is running
        if kill -0 $NGINX_PID 2>/dev/null; then
            echo "✅ Nginx proxy is running on port 80"
            echo "   Proxy endpoints: http://localhost/{API_KEY}/mcp and /{API_KEY}/sse"
            echo "   Health check: http://localhost/health"
        else
            echo "❌ Failed to start Nginx proxy"
            exit 1
        fi
    fi
}

stop_nginx() {
    if [ "$ENABLE_NGINX" = "true" ] && [ -n "$NGINX_PID" ]; then
        echo "🛑 Stopping Nginx proxy..."
        kill $NGINX_PID 2>/dev/null || true
    fi
}

# Cleanup function
cleanup() {
    echo "🛑 Shutting down services..."
    stop_nginx
    if [ -n "$SERVER_PID" ]; then kill $SERVER_PID 2>/dev/null || true; fi
    if [ -n "$MCP_PID" ]; then kill $MCP_PID 2>/dev/null || true; fi
    if [ -n "$SSE_PID" ]; then kill $SSE_PID 2>/dev/null || true; fi
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Start the server based on mode (start Nginx AFTER services are healthy)
case "$ANYCRAWL_MODE" in
    "MCP,SSE"|"SSE,MCP"|"MCP_AND_SSE")
        echo "📡 Starting MCP(JSON) on :$ANYCRAWL_MCP_PORT and SSE on :$ANYCRAWL_SSE_PORT"
        echo "   MCP upstream: :$ANYCRAWL_MCP_PORT/mcp (stateful JSON)"
        echo "   SSE upstream: :$ANYCRAWL_SSE_PORT/sse"

        # Start MCP
        ANYCRAWL_PORT=$ANYCRAWL_MCP_PORT ANYCRAWL_MODE=MCP node dist/cli.js &
        MCP_PID=$!
        # Start SSE
        ANYCRAWL_PORT=$ANYCRAWL_SSE_PORT ANYCRAWL_MODE=SSE node dist/cli.js &
        SSE_PID=$!

        if health_check "$ANYCRAWL_MCP_PORT" && health_check "$ANYCRAWL_SSE_PORT"; then
            # Start Nginx after backends are ready
            start_nginx
            echo "✅ MCP and SSE are ready"
            while true; do
                sleep 1
                if ! kill -0 $MCP_PID 2>/dev/null; then echo "❌ MCP stopped"; cleanup; fi
                if ! kill -0 $SSE_PID 2>/dev/null; then echo "❌ SSE stopped"; cleanup; fi
            done
        else
            echo "❌ One of the services failed to start"
            cleanup
        fi
        ;;
    "MCP")
        echo "📡 Starting only MCP(JSON) on :$ANYCRAWL_MCP_PORT"
        ANYCRAWL_PORT=$ANYCRAWL_MCP_PORT ANYCRAWL_MODE=MCP node dist/cli.js &
        MCP_PID=$!
        if health_check "$ANYCRAWL_MCP_PORT"; then
            start_nginx
            while true; do
                sleep 1
                if ! kill -0 $MCP_PID 2>/dev/null; then echo "❌ MCP stopped"; cleanup; fi
            done
        else
            echo "❌ MCP failed to start"; cleanup
        fi
        ;;
    "SSE")
        echo "📡 Starting only SSE on :$ANYCRAWL_SSE_PORT"
        ANYCRAWL_PORT=$ANYCRAWL_SSE_PORT ANYCRAWL_MODE=SSE node dist/cli.js &
        SSE_PID=$!
        if health_check "$ANYCRAWL_SSE_PORT"; then
            start_nginx
            while true; do
                sleep 1
                if ! kill -0 $SSE_PID 2>/dev/null; then echo "❌ SSE stopped"; cleanup; fi
            done
        else
            echo "❌ SSE failed to start"; cleanup
        fi
        ;;
    *)
        echo "❌ Unknown mode: $ANYCRAWL_MODE"
        echo "   Supported modes: MCP, SSE"
        exit 1
        ;;
esac
