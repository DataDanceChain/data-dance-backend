#!/bin/bash

# 多场景爬虫系统测试
# 覆盖不同数据类型、不同业务流程、边界情况

set -e

API_BASE="http://127.0.0.1:10000/api"
USERS=()
TOKENS=()

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')] $1${NC}"
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

error() {
    echo -e "${RED}❌ $1${NC}"
}

# 创建多个测试用户
create_test_users() {
    log "创建多类型测试用户"
    
    local user_types=("heavy_buyer" "casual_shopper" "event_organizer" "developer" "tester")
    
    for i in "${!user_types[@]}"; do
        local user_type="${user_types[$i]}"
        local timestamp=$(date +%s)_$i
        local email="${user_type}_${timestamp}@example.com"
        
        # 注册用户
        local register_response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
            -X POST \
            -H "Content-Type: application/json" \
            -d "{
                \"email\": \"$email\",
                \"password\": \"TestPassword123!\",
                \"name\": \"$(echo $user_type | tr '_' ' ' | sed 's/.*/\L&/; s/[a-z]*/\u&/g') User\",
                \"referralCode\": \"MULTI001\"
            }" \
            "$API_BASE/auth/register")
        
        # 登录获取token
        local login_response=$(curl -s -w "HTTPSTATUS:%{http_code}" \
            -X POST \
            -H "Content-Type: application/json" \
            -d "{
                \"email\": \"$email\",
                \"password\": \"TestPassword123!\"
            }" \
            "$API_BASE/auth/login")
        
        local token=$(echo $login_response | sed -e 's/HTTPSTATUS\:.*//g' | jq -r '.data.token')
        
        USERS+=("$email")
        TOKENS+=("$token")
        
        success "创建用户: ${user_type} (${email})"
    done
}

# 测试1: 多样化Amazon订单数据
test_diverse_amazon_orders() {
    log "测试场景1: 多样化Amazon订单数据"
    
    local token="${TOKENS[0]}"
    
    # 不同类型的Amazon订单
    local orders='[
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "111-1111111-1111111",
                "title": "MacBook Pro 14-inch M3 Pro",
                "price": "1999.99",
                "currency": "USD",
                "category": "Electronics",
                "quantity": 1,
                "seller": "Apple Store"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/111-1111111-1111111",
                "category": "order",
                "purchaseDate": "'$(date -u +"%Y-%m-%d")'"
            }
        },
        {
            "source": "amazon",
            "type": "order", 
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "222-2222222-2222222",
                "title": "Organic Coffee Beans 2lb",
                "price": "24.99",
                "currency": "USD",
                "category": "Grocery",
                "quantity": 3,
                "brand": "Blue Bottle Coffee"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/222-2222222-2222222",
                "category": "order",
                "deliveryDate": "'$(date -u -d "+3 days" +"%Y-%m-%d")'"
            }
        },
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "333-3333333-3333333",
                "title": "Kindle Paperwhite (16 GB)",
                "price": "139.99", 
                "currency": "USD",
                "category": "Electronics",
                "quantity": 1,
                "warranty": "1 year"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/333-3333333-3333333",
                "category": "order",
                "giftOrder": true
            }
        }
    ]'
    
    local result=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$orders" \
        "$API_BASE/crawler/upload")
    
    local status=$(echo $result | sed -e 's/.*HTTPSTATUS://')
    local body=$(echo $result | sed -e 's/HTTPSTATUS\:.*//g')
    
    if [ "$status" = "200" ]; then
        local uploaded=$(echo $body | jq '.data.uploadedCount')
        success "多样化Amazon订单上传成功: $uploaded 条"
        echo "$body" | jq '.data' > /dev/null && success "响应格式正确"
    else
        error "Amazon订单上传失败 (HTTP $status)"
    fi
}

# 测试2: 复杂Luma事件数据
test_complex_luma_events() {
    log "测试场景2: 复杂Luma事件数据"
    
    local token="${TOKENS[2]}"  # 使用event_organizer用户
    
    local events='[
        {
            "source": "luma",
            "type": "event",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "eventId": "evt_tech_conf_2024",
                "title": "AI & Web3 Tech Conference 2024",
                "date": "'$(date -u -d "+30 days" +"%Y-%m-%dT%H:%M:%S.000Z")'",
                "location": "San Francisco Moscone Center",
                "attendees": 2500,
                "price": 599,
                "currency": "USD",
                "speakers": ["Vitalik Buterin", "Sam Altman", "Fei-Fei Li"],
                "tracks": ["AI/ML", "Blockchain", "DeFi", "NFTs"]
            },
            "metadata": {
                "sourceUrl": "https://luma.com/event/evt_tech_conf_2024",
                "category": "conference",
                "tags": ["technology", "AI", "blockchain"],
                "organizer": "Tech Events Inc"
            }
        },
        {
            "source": "luma",
            "type": "task",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "taskId": "task_venue_booking_001",
                "title": "Book conference venue and catering",
                "dueDate": "'$(date -u -d "+7 days" +"%Y-%m-%dT%H:%M:%S.000Z")'",
                "status": "in_progress",
                "priority": "high",
                "assignee": "events@techconf.com",
                "estimatedHours": 20
            },
            "metadata": {
                "sourceUrl": "https://luma.com/task/task_venue_booking_001", 
                "category": "logistics",
                "parentEventId": "evt_tech_conf_2024"
            }
        },
        {
            "source": "luma", 
            "type": "event",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "eventId": "evt_workshop_react_001",
                "title": "React 18 Advanced Patterns Workshop",
                "date": "'$(date -u -d "+14 days" +"%Y-%m-%dT%H:%M:%S.000Z")'",
                "location": "Online",
                "attendees": 50,
                "price": 99,
                "currency": "USD",
                "duration": "4 hours",
                "level": "advanced"
            },
            "metadata": {
                "sourceUrl": "https://luma.com/event/evt_workshop_react_001",
                "category": "workshop", 
                "isOnline": true
            }
        }
    ]'
    
    local result=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$events" \
        "$API_BASE/crawler/upload")
    
    local status=$(echo $result | sed -e 's/.*HTTPSTATUS://')
    local body=$(echo $result | sed -e 's/HTTPSTATUS\:.*//g')
    
    if [ "$status" = "200" ]; then
        local uploaded=$(echo $body | jq '.data.uploadedCount')
        success "复杂Luma事件上传成功: $uploaded 条"
    else
        error "Luma事件上传失败 (HTTP $status)"
    fi
}

# 测试3: 边界情况和异常数据
test_edge_cases() {
    log "测试场景3: 边界情况和异常数据"
    
    local token="${TOKENS[4]}"  # 使用tester用户
    
    # 测试各种边界情况
    local edge_cases='[
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "999-9999999-9999999",
                "title": "这是一个非常非常非常长的商品标题，包含特殊字符：!@#$%^&*()，中文字符，以及emoji 🎉🚀💻",
                "price": "0.01",
                "currency": "USD",
                "category": "Test"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/999-9999999-9999999",
                "category": "edge_case"
            }
        },
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "000-0000000-0000000",
                "title": "",
                "price": "99999.99",
                "currency": "EUR"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/000-0000000-0000000"
            }
        }
    ]'
    
    local result=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$edge_cases" \
        "$API_BASE/crawler/upload")
    
    local status=$(echo $result | sed -e 's/.*HTTPSTATUS://')
    local body=$(echo $result | sed -e 's/HTTPSTATUS\:.*//g')
    
    if [ "$status" = "200" ]; then
        local uploaded=$(echo $body | jq '.data.uploadedCount')
        success "边界情况数据处理成功: $uploaded 条"
    else
        error "边界情况测试失败 (HTTP $status)"
    fi
}

# 测试4: 跨用户查重验证
test_cross_user_deduplication() {
    log "测试场景4: 跨用户查重验证"
    
    local shared_orderid="555-5555555-5555555"
    
    # 用户1上传
    local user1_data='[{
        "source": "amazon", 
        "type": "order",
        "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
        "payload": {
            "orderid": "'$shared_orderid'",
            "title": "共享商品 - 用户1视角",
            "price": "49.99",
            "currency": "USD",
            "review": "非常好用，推荐购买！"
        },
        "metadata": {
            "sourceUrl": "https://amazon.com/order/'$shared_orderid'",
            "userExperience": "positive"
        }
    }]'
    
    # 用户2上传相同orderid
    local user2_data='[{
        "source": "amazon",
        "type": "order", 
        "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
        "payload": {
            "orderid": "'$shared_orderid'",
            "title": "共享商品 - 用户2视角", 
            "price": "49.99",
            "currency": "USD",
            "review": "质量一般，不太推荐"
        },
        "metadata": {
            "sourceUrl": "https://amazon.com/order/'$shared_orderid'",
            "userExperience": "negative"
        }
    }]'
    
    # 用户1上传
    local result1=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKENS[0]}" \
        -d "$user1_data" \
        "$API_BASE/crawler/upload")
    
    # 用户2上传相同orderid（应该成功）
    local result2=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKENS[1]}" \
        -d "$user2_data" \
        "$API_BASE/crawler/upload")
    
    local status1=$(echo $result1 | sed -e 's/.*HTTPSTATUS://')
    local body1=$(echo $result1 | sed -e 's/HTTPSTATUS\:.*//g')
    local uploaded1=$(echo $body1 | jq '.data.uploadedCount // 0')
    
    local status2=$(echo $result2 | sed -e 's/.*HTTPSTATUS://')
    local body2=$(echo $result2 | sed -e 's/HTTPSTATUS\:.*//g')
    local uploaded2=$(echo $body2 | jq '.data.uploadedCount // 0')
    
    if [ "$uploaded1" = "1" ] && [ "$uploaded2" = "1" ]; then
        success "跨用户orderid共享正常工作"
    else
        error "跨用户查重逻辑异常: 用户1=$uploaded1, 用户2=$uploaded2"
    fi
    
    # 用户1重复上传（应该失败）
    local result3=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKENS[0]}" \
        -d "$user1_data" \
        "$API_BASE/crawler/upload")
    
    local body3=$(echo $result3 | sed -e 's/HTTPSTATUS\:.*//g')
    local duplicates3=$(echo $body3 | jq '.data.duplicatesCount // 0')
    
    if [ "$duplicates3" = "1" ]; then
        success "用户内重复检测正常工作"
    else
        error "用户内查重逻辑异常: 重复=$duplicates3"
    fi
}

# 测试5: 批量数据和性能测试
test_batch_performance() {
    log "测试场景5: 批量数据和性能测试"
    
    local token="${TOKENS[0]}"
    
    # 生成30条Amazon订单数据
    local batch_data='['
    for i in {1..30}; do
        local orderid=$(printf "100-%07d-%07d" $((1000000 + i)) $((2000000 + i)))
        if [ $i -gt 1 ]; then
            batch_data+=','
        fi
        batch_data+='
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "'$orderid'",
                "title": "批量测试商品 #'$i'",
                "price": "'$(printf "%.2f" $(echo "scale=2; ($i * 10 + 9)" | bc))'",
                "currency": "USD",
                "category": "Batch Test"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/'$orderid'",
                "batchId": "batch_001"
            }
        }'
    done
    batch_data+=']'
    
    local start_time=$(date +%s)
    local result=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$batch_data" \
        "$API_BASE/crawler/upload")
    local end_time=$(date +%s)
    
    local duration=$((end_time - start_time))
    local status=$(echo $result | sed -e 's/.*HTTPSTATUS://')
    local body=$(echo $result | sed -e 's/HTTPSTATUS\:.*//g')
    
    if [ "$status" = "200" ]; then
        local uploaded=$(echo $body | jq '.data.uploadedCount')
        local points=$(echo $body | jq '.data.pointsEarned')
        success "批量上传完成: $uploaded 条数据，$points 积分，耗时 ${duration}s"
        
        # 性能检查
        if [ $duration -le 8 ]; then
            success "性能测试通过: ${duration}s <= 8s"
        else
            warning "性能较慢: ${duration}s > 8s"
        fi
    else
        error "批量上传失败 (HTTP $status)"
    fi
}

# 测试6: 混合数据流程
test_mixed_workflow() {
    log "测试场景6: 混合数据流程"
    
    local token="${TOKENS[3]}"  # 使用developer用户
    
    # 混合Amazon和Luma数据
    local mixed_data='[
        {
            "source": "amazon",
            "type": "order",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "orderid": "777-7777777-7777777",
                "title": "Programming Books Bundle",
                "price": "89.99",
                "currency": "USD", 
                "category": "Books"
            },
            "metadata": {
                "sourceUrl": "https://amazon.com/order/777-7777777-7777777",
                "purpose": "learning"
            }
        },
        {
            "source": "luma",
            "type": "event",
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "eventId": "evt_coding_bootcamp",
                "title": "Full-Stack Web Development Bootcamp",
                "date": "'$(date -u -d "+60 days" +"%Y-%m-%dT%H:%M:%S.000Z")'",
                "location": "Online",
                "attendees": 30,
                "duration": "12 weeks"
            },
            "metadata": {
                "sourceUrl": "https://luma.com/event/evt_coding_bootcamp",
                "category": "education"
            }
        },
        {
            "source": "luma",
            "type": "task", 
            "timestamp": "'$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")'",
            "payload": {
                "taskId": "task_study_plan",
                "title": "Create personal study plan",
                "dueDate": "'$(date -u -d "+3 days" +"%Y-%m-%dT%H:%M:%S.000Z")'",
                "status": "pending",
                "tags": ["education", "planning"]
            },
            "metadata": {
                "sourceUrl": "https://luma.com/task/task_study_plan",
                "category": "planning"
            }
        }
    ]'
    
    local result=$(curl -s -w "HTTPSTATUS:%{http_code}" \
        -X POST \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$mixed_data" \
        "$API_BASE/crawler/upload")
    
    local status=$(echo $result | sed -e 's/.*HTTPSTATUS://')
    local body=$(echo $result | sed -e 's/HTTPSTATUS\:.*//g')
    
    if [ "$status" = "200" ]; then
        local uploaded=$(echo $body | jq '.data.uploadedCount')
        success "混合数据流程成功: $uploaded 条"
        
        # 验证质量报告
        local quality_reports=$(echo $body | jq '.data.qualityReports | length')
        if [ "$quality_reports" = "3" ]; then
            success "质量评分报告完整"
        else
            warning "质量报告数量异常: $quality_reports"
        fi
    else
        error "混合数据流程失败 (HTTP $status)"
    fi
}

# 主测试流程
main() {
    echo -e "${BLUE}🚀 多场景爬虫系统测试${NC}"
    echo "=================================================="
    
    # 创建测试用户
    create_test_users
    
    echo
    echo "开始多场景测试..."
    
    # 执行各种测试场景
    test_diverse_amazon_orders
    echo
    test_complex_luma_events  
    echo
    test_edge_cases
    echo
    test_cross_user_deduplication
    echo
    test_batch_performance
    echo
    test_mixed_workflow
    
    echo
    echo -e "${GREEN}🎉 多场景测试完成！${NC}"
    echo "=================================================="
    echo "测试覆盖："
    echo "✅ 多样化Amazon订单数据（不同类别、价格、属性）"
    echo "✅ 复杂Luma事件数据（会议、工作坊、任务）"
    echo "✅ 边界情况（特殊字符、极值、空值）"
    echo "✅ 跨用户查重验证（不同用户体验共享）"
    echo "✅ 批量数据性能测试（30条数据）"
    echo "✅ 混合数据流程（Amazon + Luma）"
    echo
    echo "用户角色："
    echo "👤 重度购买者、休闲购物者、活动组织者、开发者、测试员"
}

main "$@" 