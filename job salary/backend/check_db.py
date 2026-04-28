import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask
from models import db, SalaryRecord

app = Flask(__name__)
basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'salary.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

with app.app_context():
    print("=" * 60)
    print("数据库诊断")
    print("=" * 60)
    
    total_count = db.session.query(SalaryRecord).count()
    print(f"\n数据库中总记录数: {total_count}")
    
    if total_count == 0:
        print("\n❌ 数据库为空！请先初始化测试数据。")
        print("请在浏览器控制台执行: initTestData()")
        print("或者运行以下命令添加数据。")
    else:
        from datetime import timedelta
        now = datetime.utcnow()
        
        print(f"\n当前时间 (UTC): {now}")
        
        records = db.session.query(SalaryRecord).all()
        
        print(f"\n样本记录 (前5条):")
        for i, r in enumerate(records[:5]):
            print(f"  [{i+1}] 岗位: {r.position}, 行业: {r.industry}, 地点: {r.location}")
            print(f"       薪资: {r.last_salary}, 创建时间: {r.created_at}")
        
        print(f"\n时间范围检查:")
        
        time_ranges = {
            'week': now - timedelta(days=7),
            'month': now - timedelta(days=30),
            'half_year': now - timedelta(days=183),
            'year': now - timedelta(days=365),
        }
        
        for name, cutoff in time_ranges.items():
            count = db.session.query(SalaryRecord).filter(
                SalaryRecord.created_at >= cutoff
            ).count()
            print(f"  {name} ({cutoff}) 范围内的记录数: {count}")
        
        print(f"\n所有记录的创建时间范围:")
        min_date = db.session.query(db.func.min(SalaryRecord.created_at)).scalar()
        max_date = db.session.query(db.func.max(SalaryRecord.created_at)).scalar()
        print(f"  最早: {min_date}")
        print(f"  最晚: {max_date}")
        
        if max_date and max_date < (now - timedelta(days=30)):
            print(f"\n⚠️  警告: 最新的记录是 {max_date}，已超过30天！")
            print(f"   默认查询'30天内'将找不到任何记录！")
            print(f"\n建议: 选择'一年内'时间段，或重新初始化测试数据。")

print("\n" + "=" * 60)
