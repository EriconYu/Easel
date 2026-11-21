.DEFAULT_GOAL := help

PYTHON ?= $(if $(wildcard .venv/bin/python),.venv/bin/python,python3)
PORT ?= 7860
EASEL_HOST ?= 127.0.0.1

.PHONY: help run run-daemon

help:
	@printf '%s\n' \
		'make help         显示可用命令（默认）' \
		'make run          在前台启动工作台，按 Ctrl+C 停止' \
		'make run-daemon   在后台启动工作台，输出 PID 和日志路径' \
		'' \
		'默认访问 http://127.0.0.1:7860，使用 PORT=7861 可更改端口。'

run:
	@EASEL_HOST="$(EASEL_HOST)" "$(PYTHON)" -m easel web --port "$(PORT)"

run-daemon:
	@EASEL_HOST="$(EASEL_HOST)" "$(PYTHON)" -m easel web --port "$(PORT)" --daemon
