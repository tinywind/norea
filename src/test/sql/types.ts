export interface TestQueryResult {
  rowsAffected: number;
  lastInsertId?: number;
}

export interface TestSqliteDatabase {
  path?: string;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  execute(query: string, bindValues?: unknown[]): Promise<TestQueryResult>;
  close?(db?: string): Promise<boolean>;
}
