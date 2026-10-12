"""Render binding and single-process Messenger worker configuration."""

import os

bind = f"0.0.0.0:{int(os.environ.get('PORT', 5000))}"
workers = 1
worker_class = "gthread"
threads = 4
timeout = 60
accesslog = "-"
errorlog = "-"
# Exclude query strings: Meta's GET verification carries its token in the URL.
access_log_format = '%(t)s "%(m)s %(U)s %(H)s" %(s)s %(b)s %(L)s'
# Each process starts a background Messenger worker thread for jobs/sessions.
# Scale only after replacing local state with a shared database/job queue.
preload_app = False
