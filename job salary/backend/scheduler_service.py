import os
import json
import logging
from datetime import datetime
from typing import Optional, Dict, Any, List

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR

from models import db, ScheduledCrawl, CrawlTask
from crawl_service import crawl_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class SchedulerService:
    def __init__(self, app=None):
        self.scheduler = BackgroundScheduler()
        self.app = app
        self._initialized = False
        
        if app:
            self.init_app(app)
    
    def init_app(self, app):
        self.app = app
        
        if not self._initialized:
            self.scheduler.add_listener(self._job_listener, EVENT_JOB_EXECUTED | EVENT_JOB_ERROR)
            self._initialized = True
    
    def start(self):
        if not self.scheduler.running:
            self.scheduler.start()
            logger.info("Scheduler service started")
            
            with self.app.app_context():
                self._load_active_schedules()
    
    def stop(self):
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
            logger.info("Scheduler service stopped")
    
    def _load_active_schedules(self):
        try:
            active_schedules = ScheduledCrawl.query.filter_by(is_active=True).all()
            
            for schedule in active_schedules:
                self._add_job_to_scheduler(schedule)
            
            logger.info(f"Loaded {len(active_schedules)} active scheduled tasks")
        except Exception as e:
            logger.error(f"Error loading active schedules: {e}")
    
    def _add_job_to_scheduler(self, schedule: ScheduledCrawl):
        try:
            job_id = f"schedule_{schedule.schedule_id}"
            
            if self.scheduler.get_job(job_id):
                self.scheduler.remove_job(job_id)
            
            cron_parts = schedule.cron_expression.split()
            if len(cron_parts) != 5:
                logger.error(f"Invalid cron expression: {schedule.cron_expression}")
                return
            
            trigger = CronTrigger(
                minute=cron_parts[0],
                hour=cron_parts[1],
                day=cron_parts[2],
                month=cron_parts[3],
                day_of_week=cron_parts[4]
            )
            
            self.scheduler.add_job(
                self._execute_scheduled_task,
                trigger=trigger,
                id=job_id,
                name=schedule.schedule_name,
                args=[schedule.schedule_id],
                replace_existing=True
            )
            
            logger.info(f"Added scheduled job: {schedule.schedule_name} (ID: {job_id})")
        except Exception as e:
            logger.error(f"Error adding job to scheduler: {e}")
    
    def _remove_job_from_scheduler(self, schedule_id: str):
        job_id = f"schedule_{schedule_id}"
        if self.scheduler.get_job(job_id):
            self.scheduler.remove_job(job_id)
            logger.info(f"Removed scheduled job: {job_id}")
    
    def _execute_scheduled_task(self, schedule_id: str):
        with self.app.app_context():
            try:
                schedule = ScheduledCrawl.query.filter_by(schedule_id=schedule_id).first()
                
                if not schedule or not schedule.is_active:
                    logger.warning(f"Scheduled task {schedule_id} not found or inactive")
                    return
                
                schedule.last_run_at = datetime.utcnow()
                schedule.last_run_status = 'running'
                db.session.commit()
                
                logger.info(f"Executing scheduled task: {schedule.schedule_name}")
                
                target_urls = None
                if schedule.target_urls:
                    try:
                        target_urls = json.loads(schedule.target_urls)
                    except:
                        target_urls = schedule.target_urls.split(',') if ',' in schedule.target_urls else [schedule.target_urls]
                
                task_id = crawl_service.start_crawl_task(
                    task_name=f"定时任务: {schedule.schedule_name}",
                    job_type=schedule.job_type,
                    search_keyword=schedule.search_keyword,
                    target_urls=target_urls
                )
                
                schedule.last_run_status = 'started'
                db.session.commit()
                
                logger.info(f"Scheduled task {schedule.schedule_name} started with task_id: {task_id}")
                
            except Exception as e:
                logger.error(f"Error executing scheduled task {schedule_id}: {e}")
                try:
                    schedule = ScheduledCrawl.query.filter_by(schedule_id=schedule_id).first()
                    if schedule:
                        schedule.last_run_status = 'failed'
                        db.session.commit()
                except:
                    pass
    
    def _job_listener(self, event):
        if event.exception:
            logger.error(f"Job {event.job_id} failed: {event.exception}")
        else:
            logger.info(f"Job {event.job_id} executed successfully")
    
    def add_schedule(self, schedule: ScheduledCrawl):
        if schedule.is_active:
            self._add_job_to_scheduler(schedule)
    
    def update_schedule(self, schedule: ScheduledCrawl):
        if schedule.is_active:
            self._add_job_to_scheduler(schedule)
        else:
            self._remove_job_from_scheduler(schedule.schedule_id)
    
    def delete_schedule(self, schedule_id: str):
        self._remove_job_from_scheduler(schedule_id)
    
    def get_scheduler_status(self) -> Dict[str, Any]:
        jobs = self.scheduler.get_jobs()
        return {
            'running': self.scheduler.running,
            'job_count': len(jobs),
            'jobs': [
                {
                    'id': job.id,
                    'name': job.name,
                    'next_run_time': job.next_run_time.isoformat() if job.next_run_time else None
                }
                for job in jobs
            ]
        }


scheduler_service = SchedulerService()
