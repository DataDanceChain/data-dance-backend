#!/bin/bash

# Test script to verify duplicate detection with real API
echo "🧪 Testing duplicate detection with real API calls..."

# You need to replace this with a real JWT token from your frontend testing
# TOKEN="your-real-jwt-token-here"

# If no token provided, show instructions
if [ -z "$1" ]; then
    echo "❌ Please provide a JWT token as the first argument"
    echo "Usage: $0 'your-jwt-token-here'"
    echo ""
    echo "To get a token:"
    echo "1. Login to the frontend"
    echo "2. Open browser dev tools"
    echo "3. Go to Network tab"
    echo "4. Make any API call"
    echo "5. Copy the Authorization header value (without 'Bearer ')"
    exit 1
fi

TOKEN="$1"
API_URL="http://localhost:10000/api/crawler/upload"

# Test data with same orderid
TEST_DATA='{
  "data": [{
    "source": "amazon",
    "type": "order",
    "payload": {
      "orderid": "duplicate-test-001",
      "title": "Duplicate Test Product",
      "price": 99.99,
      "currency": "USD",
      "date": "2024-01-20"
    },
    "metadata": {
      "sourceUrl": "https://amazon.com/orders/duplicate-test-001"
    },
    "timestamp": "2024-01-20T10:00:00Z"
  }]
}'

echo "📤 First upload (should succeed)..."
RESPONSE1=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: first-upload-$(date +%s)" \
  -d "$TEST_DATA")

echo "Response 1:"
echo "$RESPONSE1" | jq .
echo ""

# Wait a moment
sleep 2

echo "📤 Second upload (should detect duplicate)..."
RESPONSE2=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: second-upload-$(date +%s)" \
  -d "$TEST_DATA")

echo "Response 2:"
echo "$RESPONSE2" | jq .
echo ""

# Check if duplicates were detected
DUPLICATES_COUNT=$(echo "$RESPONSE2" | jq -r '.data.duplicatesCount // 0')
if [ "$DUPLICATES_COUNT" -gt 0 ]; then
    echo "✅ Duplicate detection is working! Found $DUPLICATES_COUNT duplicates"
else
    echo "❌ Duplicate detection failed - no duplicates detected"
fi

echo ""
echo "🔍 Checking database for duplicate records..."
docker compose exec ddc-backend-db psql -U ddc -d ddc -c "SELECT count(*) as record_count, \"sourceId\" FROM \"CrawlerData\" WHERE \"sourceId\" = 'duplicate-test-001' GROUP BY \"sourceId\";"