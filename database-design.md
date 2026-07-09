# 单围棋联网对战数据库设计

## 1. players 玩家信息表
存储玩家基本信息和对战统计

```sql
players {
  _id: string,               // 玩家ID（云开发默认）
  openid: string,            // 微信openid
  nickname: string,          // 玩家昵称
  avatar: string,            // 头像URL
  elo_rating: number,        // ELO等级分
  total_games: number,       // 总对局数
  wins: number,              // 胜利数
  losses: number,            // 失败数
  draws: number,             // 平局数
  created_at: timestamp,     // 创建时间
  updated_at: timestamp      // 更新时间
}
```

## 2. match_queue 匹配队列表
存储等待匹配的玩家信息

```sql
match_queue {
  _id: string,               // 队列ID
  player_id: string,         // 玩家ID（关联players._id）
  openid: string,            // 微信openid
  nickname: string,          // 玩家昵称
  avatar: string,            // 头像URL
  elo_rating: number,        // ELO等级分（用于匹配）
  join_time: timestamp,      // 加入队列时间
  status: string,            // 状态：waiting, matched, cancelled
  matched_game_id: string,   // 匹配成功后关联的游戏ID
  matched_player_id: string  // 匹配到的对手ID
}
```

## 3. games 对局信息表
存储对局的基本信息和状态

```sql
games {
  _id: string,               // 游戏ID
  black_player_id: string,   // 黑方玩家ID
  white_player_id: string,   // 白方玩家ID
  black_openid: string,      // 黑方openid
  white_openid: string,      // 白方openid
  black_nickname: string,    // 黑方昵称
  white_nickname: string,    // 白方昵称
  black_avatar: string,      // 黑方头像
  white_avatar: string,      // 白方头像
  board_size: number,        // 棋盘大小（13/15/19）
  current_player: string,    // 当前玩家：black/white
  board_state: array,        // 棋盘状态二维数组
  move_count: number,        // 已走步数
  status: string,            // 状态：waiting, playing, black_win, white_win, draw, black_resign, white_resign, disconnected, cancelled
  winner: string,            // 胜利者：black/white/draw
  winner_reason: string,     // 胜利原因：surround, self_surround, two_rows, resign, disconnect
  start_time: timestamp,     // 对局开始时间
  end_time: timestamp,       // 对局结束时间
  last_move_time: timestamp, // 最后一步时间（用于超时判断）
  created_at: timestamp,     // 创建时间
  updated_at: timestamp      // 更新时间
}
```

## 4. moves 棋步记录表
记录每一步棋的详细信息

```sql
moves {
  _id: string,               // 步数ID
  game_id: string,          // 游戏ID（关联games._id）
  move_number: number,       // 步数序号（从1开始）
  player: string,           // 玩家：black/white
  row: number,              // 行坐标（0-based）
  col: number,              // 列坐标（0-based）
  piece: number,            // 棋子：1=黑, 2=白
  timestamp: timestamp,     // 落子时间
  board_state_before: array, // 落子前的棋盘状态
  board_state_after: array,  // 落子后的棋盘状态
  game_result: string,      // 走完此步后的游戏结果：playing, black_win, white_win, draw, null
  is_undo: boolean,         // 是否被悔棋撤销
  created_at: timestamp     // 创建时间
}
```

## 5. undo_requests 悔棋请求表
存储悔棋请求和处理状态

```sql
undo_requests {
  _id: string,               // 请求ID
  game_id: string,          // 游戏ID
  requester: string,        // 请求者：black/white
  target_move_number: number, // 请求悔棋到的步数
  reason: string,           // 请求原因（可选）
  status: string,           // 状态：pending, approved, rejected, expired
  response_by: string,      // 响应者：black/white
  response_time: timestamp, // 响应时间
  created_at: timestamp,     // 创建时间
  updated_at: timestamp      // 更新时间
}
```

## 6. game_invitations 游戏邀请表（可选）
用于好友对战邀请

```sql
game_invitations {
  _id: string,               // 邀请ID
  inviter_id: string,       // 邀请者ID
  invitee_id: string,       // 被邀请者ID
  game_id: string,          // 关联的游戏ID
  status: string,           // 状态：pending, accepted, rejected, expired
  message: string,         // 邀请消息
  created_at: timestamp,    // 创建时间
  updated_at: timestamp     // 更新时间
}
```

## 索引设计

### players 表索引
- 主键：`_id`
- 唯一索引：`openid`
- 复合索引：`elo_rating`（用于匹配）

### match_queue 表索引
- 主键：`_id`
- 索引：`player_id`（唯一，一个玩家只能在一个队列中）
- 索引：`status` + `join_time`（用于查找等待时间最长的玩家）
- 索引：`openid`

### games 表索引
- 主键：`_id`
- 复合索引：`black_player_id` + `status`
- 复合索引：`white_player_id` + `status`
- 索引：`created_at`（按时间排序）
- 复合索引：`status` + `updated_at`（查找活跃对局）

### moves 表索引
- 主键：`_id`
- 复合索引：`game_id` + `move_number`（按游戏和步数查询）
- 索引：`game_id` + `player`
- 索引：`timestamp`

### undo_requests 表索引
- 主键：`_id`
- 复合索引：`game_id` + `status`（查找待处理的悔棋请求）
- 索引：`created_at`

## 实时同步设计

使用云开发的实时数据库或WebSocket实现：
1. 玩家落子时，客户端发送棋步到云函数
2. 云函数验证棋步合法性
3. 更新`games`表和`moves`表
4. 通过实时数据库推送更新到对手客户端
5. 对手客户端接收更新并同步棋盘状态

## 匹配算法逻辑

1. 玩家加入队列时，记录其ELO等级分和加入时间
2. 定期运行匹配函数（每5秒）
3. 匹配原则：
   - 优先匹配ELO等级分相近的玩家（±100分）
   - 如果30秒内未找到相近ELO对手，扩大匹配范围（±200分）
   - 如果60秒内仍未找到，匹配等待时间最长的两名玩家
4. 匹配成功后：
   - 随机分配黑方/白方
   - 创建新游戏记录
   - 将两名玩家从队列移除
   - 推送匹配成功通知到双方客户端