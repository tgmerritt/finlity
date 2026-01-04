import sqlite3
import sys
import os

db_path = "./data/demo/demo.db"

def inspect_updates():
    if not os.path.exists(db_path):
        print(f"Database not found at {db_path}")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = [row[0] for row in cursor.fetchall()]
    
    latest_updates = []

    for table in tables:
        # Get columns
        cursor.execute(f"PRAGMA table_info({table});")
        columns = cursor.fetchall()
        
        # Look for time-related columns
        # Use more specific suffixes/substrings
        time_cols = [col[1] for col in columns if '_at' in col[1].lower() or '_date' in col[1].lower() or 'time' in col[1].lower()]
        
        for col in time_cols:
            try:
                cursor.execute(f"SELECT MAX({col}) FROM {table}")
                val = cursor.fetchone()[0]
                if val:
                    latest_updates.append((val, table, col))
            except Exception as e:
                pass

    conn.close()
    
    # Sort by timestamp (as string)
    latest_updates.sort(key=lambda x: str(x[0]), reverse=True)
    
    print("Most recent database timestamps:")
    for ts, table, col in latest_updates[:10]:
        print(f"{ts} | {table}.{col}")

if __name__ == "__main__":
    inspect_updates()
