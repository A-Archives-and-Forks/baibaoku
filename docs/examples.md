# 使用场景示例

## 扩展配置

```js
const db = await BaiBaoKuClient.open('my-extension', {
  displayName: 'My Extension',
  version: 1,
});

await db.set('settings', 'enabled', true);
await db.set('settings', 'layout', {
  compact: true,
  panelWidth: 360,
});
```

## 角色相关数据

```js
await db.set('characters', `${characterId}/notes/main`, {
  content: '这张卡有长期记忆。',
  updatedAt: Date.now(),
});

const notes = await db.entries('characters', `${characterId}/notes/`);
```

## 缓存

```js
await db.set('cache', 'latest-analysis', result, {
  ttl: 60 * 30,
});

const cached = await db.get('cache', 'latest-analysis');
```

## 批量读取向量索引数据

```js
function float32ToBase64(vector) {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

await db.setMany('vectors', [
  {
    key: 'doc_001/chunk_000',
    type: 'float32',
    value: float32ToBase64([0.1, 0.2, 0.3]),
  },
  {
    key: 'doc_001/chunk_001',
    type: 'float32',
    value: float32ToBase64([0.4, 0.5, 0.6]),
  },
]);

const keys = [
  'doc_001/chunk_000',
  'doc_001/chunk_001',
  'doc_002/chunk_000',
];

const entries = await db.getMany('vectors', keys);
const vectors = entries
  .filter(entry => entry.exists)
  .map(entry => ({
    key: entry.key,
    vector: entry.value,
  }));
```

如果要按前缀取一批，也可以用 `entries`：

```js
const page = await db.entries('vectors', 'doc_001/', {
  limit: 500,
  offset: 0,
});
```

## 推荐数据库和 store 命名

数据库名建议用足够独特的英文 ID：

```text
com.author.extension-name
author-extension-name
xyzw.character-notes
```

store 建议按用途拆：

```text
settings
cache
characters
sessions
```

key 可以用斜杠模拟层级：

```text
char_123/profile
char_123/notes/main
group_456/state
```
