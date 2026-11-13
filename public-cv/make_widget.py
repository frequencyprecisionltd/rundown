#!/usr/bin/env python3
"""Make the CV box to paste into the public site: python3 make_widget.py <apps script web app url> > cv-box.html"""
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
t = open(os.path.join(here, "widget-template.html"), encoding="utf-8").read()
sys.stdout.write(t.replace("__API__", sys.argv[1]))
