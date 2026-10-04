declare module 'virtual:cn-tables' {
  const tables: Parameters<typeof import('cn/engine').createCn>[0];
  export default tables;
}
