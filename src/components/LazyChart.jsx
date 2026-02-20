import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

const LazyChart = ({ children, height = 300, threshold = 0.1 }) => {
    const [isVisible, setIsVisible] = useState(false);
    const containerRef = useRef(null);

    useEffect(() => {
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setIsVisible(true);
                    observer.disconnect(); // Render once, stay rendered
                }
            },
            {
                root: null, // viewport
                rootMargin: '100px', // preload when 100px away
                threshold
            }
        );

        if (containerRef.current) {
            observer.observe(containerRef.current);
        }

        return () => {
            if (observer) observer.disconnect();
        };
    }, [threshold]);

    return (
        <div ref={containerRef} style={{ height: '100%', width: '100%', minHeight: height }}>
            {isVisible ? (
                children
            ) : (
                <div className="lazy-placeholder" style={{
                    height: '100%',
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.02)',
                    borderRadius: 8
                }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
                        <RefreshCw className="spinner" size={20} opacity={0.5} />
                        <span style={{ fontSize: '0.8rem' }}>Loading Chart...</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default LazyChart;
