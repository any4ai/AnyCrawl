import os
import sys
from datetime import datetime, timedelta
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask
from models import db, SalaryRecord

app = Flask(__name__)
basedir = os.path.abspath(os.path.dirname(__file__))
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///' + os.path.join(basedir, 'salary.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db.init_app(app)

with app.app_context():
    print("正在初始化测试数据...")
    
    positions = ['前端开发工程师', '后端开发工程师', '产品经理', '数据分析师', 'UI设计师',
                 'Java开发工程师', 'Python开发工程师', '测试工程师', '运维工程师', '架构师',
                 '销售经理', '市场专员', '人力资源专员', '财务会计', '行政助理',
                 '项目经理', '技术总监', '运营经理', '客服专员', '算法工程师']
    
    industries = ['互联网', '金融', '教育', '医疗健康', '制造业', '零售', '房地产', '物流',
                  '文化传媒', '新能源', '人工智能', '电子商务', '游戏', '咨询服务', '外包服务']
    
    locations = ['北京', '上海', '广州', '深圳', '杭州', '南京', '苏州', '成都', '武汉',
                 '西安', '重庆', '天津', '长沙', '郑州', '青岛', '大连', '厦门', '宁波']
    
    genders = ['male', 'female']
    
    db.session.query(SalaryRecord).delete()
    
    test_records = []
    now = datetime.utcnow()
    
    for i in range(500):
        base_salary = random.randint(8000, 35000)
        experience = random.uniform(0, 15)
        age = int(22 + experience + random.uniform(0, 5))
        
        days_ago = random.randint(0, 30)
        created_at = now - timedelta(days=days_ago)
        
        record = SalaryRecord(
            position=random.choice(positions),
            industry=random.choice(industries),
            gender=random.choice(genders),
            age=age,
            experience_years=round(experience, 1),
            location=random.choice(locations),
            last_salary=base_salary,
            created_at=created_at
        )
        test_records.append(record)
    
    db.session.bulk_save_objects(test_records)
    db.session.commit()
    
    print(f"✅ 成功初始化 {len(test_records)} 条测试数据")
    print(f"\n数据统计:")
    print(f"  - 岗位数量: {len(positions)} 种")
    print(f"  - 行业数量: {len(industries)} 种")
    print(f"  - 城市数量: {len(locations)} 个")
    print(f"  - 薪资范围: 8000 - 35000")
    print(f"  - 创建时间: 最近30天内")
    
    count = db.session.query(SalaryRecord).count()
    print(f"\n数据库当前记录数: {count}")
